"""Thin k8s access for the warm-store controller — pool PVCs (by label), per-conversation
Sandboxes, the clean-shutdown marker, warm Jobs, and the leader-election Lease. Mirrors the
broker's `_apis()` singleton + 409/404 tolerance (services/broker/broker/sandbox/k8s.py).

Pure decisions live in reconcile.py; this is the imperative shell the LOOP uses.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from kubernetes import client, config

from .reconcile import PoolPvc, SandboxRef, WarmJobStatus

logger = logging.getLogger("warm-store-controller")

# Sandbox CR coordinates (agent-sandbox upstream, v1beta1).
SANDBOX_GROUP = "agents.x-k8s.io"
SANDBOX_VERSION = "v1beta1"
SANDBOX_PLURAL = "sandboxes"

# Pool PVC labels (see todo/docs/WARM_STORE_PVC_MANAGER.md).
LBL_WARM_STORE = "scooter.io/warm-store"   # image content tag (the version key)
LBL_POOL_STATE = "scooter.io/pool-state"   # warming|ready|claimed|retiring
LBL_CLAIMED_BY = "scooter.io/claimed-by"   # conv id when claimed
# last-used is an ANNOTATION, not a label — an rfc3339 timestamp's colons are illegal in a
# label value (the claim's label patch would 422). Read for LRU from annotations.
ANN_LAST_USED = "scooter.io/last-used"     # rfc3339, for LRU
LBL_WARM_PVC = "scooter.io/warm-pvc"       # on a warm Job: the PVC name it warms (PVC↔Job link)
POOL_SELECTOR = LBL_POOL_STATE             # any PVC carrying a pool-state is a pool PVC

# The clean-shutdown marker the sandbox writes into the overlay upper on graceful stop.
CLEAN_MARKER_PATH = "/nix/.scooter-rw/.clean-shutdown"

_core: client.CoreV1Api | None = None
_custom: client.CustomObjectsApi | None = None
_batch: client.BatchV1Api | None = None
_coord: client.CoordinationV1Api | None = None


def _apis() -> tuple[client.CoreV1Api, client.CustomObjectsApi, client.BatchV1Api, client.CoordinationV1Api]:
    global _core, _custom, _batch, _coord
    if _core is None:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        _core = client.CoreV1Api()
        _custom = client.CustomObjectsApi()
        _batch = client.BatchV1Api()
        _coord = client.CoordinationV1Api()
    assert _core is not None and _custom is not None and _batch is not None and _coord is not None
    return _core, _custom, _batch, _coord


@dataclass
class ControllerK8s:
    """Imperative k8s ops the reconcile LOOP uses. Pure decisions live in reconcile.py.

    :param namespace: the k8s namespace all operations target (pool PVCs, Sandboxes, Jobs).
    :param warm_job_image: sandbox image the warm Job boots.
    :param warm_golden_expr: the golden Nix expression the warm Job builds into the overlay.
    :param overlay_storage: size of each pool PVC.
    """

    namespace: str
    warm_job_image: str = ""
    warm_golden_expr: str = ""
    overlay_storage: str = "20Gi"
    # RuntimeClass for the warm Job's systemd-PID-1 pod (e.g. "crun") — a cgroup-delegating
    # runtime so systemd gets a writable cgroup subtree WITHOUT privileged (which would force
    # the host cgroup ns and let the sandbox churn the node's /kubepods tree — the host-logout
    # bug). MUST match the per-conversation sandboxRuntimeClass. Empty → cluster default.
    runtime_class: str = ""

    # --- observe -----------------------------------------------------------
    def list_pool_pvcs(self) -> list[PoolPvc]:
        """Every pool PVC (carries a pool-state label), read into the pure PoolPvc shape.
        `bound_to_pod` is derived from a live-pod scan (a pod mounting the claim); a `warming`
        PVC's `warm_job_status` from its linked warm Job (→ promote to ready / discard)."""
        core, _, _, _ = _apis()
        bound = self._claim_names_bound_to_live_pods()
        warm_status = self._warm_job_status_by_pvc()
        out: list[PoolPvc] = []
        for pvc in core.list_namespaced_persistent_volume_claim(
            self.namespace, label_selector=POOL_SELECTOR
        ).items:
            labels = pvc.metadata.labels or {}
            annotations = pvc.metadata.annotations or {}
            name = pvc.metadata.name
            out.append(
                PoolPvc(
                    name=name,
                    image_tag=labels.get(LBL_WARM_STORE, ""),
                    state=labels.get(LBL_POOL_STATE, ""),
                    claimed_by=labels.get(LBL_CLAIMED_BY),
                    last_used=annotations.get(ANN_LAST_USED),
                    bound_to_pod=name in bound,
                    warm_job_status=warm_status.get(name),
                )
            )
        return out

    def _warm_job_status_by_pvc(self) -> dict[str, WarmJobStatus]:
        """PVC name → its warm Job's terminal state ("succeeded"|"failed"|"running"), via the
        LBL_WARM_PVC link. A PVC with no warm Job (Job GC'd after ttl) is absent → the loop
        treats it as still warming until GC/timeout — safe (a stuck warming PVC is bounded by
        the Job's activeDeadline; a promoted one is already `ready`, not `warming`)."""
        _, _, batch, _ = _apis()
        out: dict[str, WarmJobStatus] = {}
        for job in batch.list_namespaced_job(self.namespace, label_selector="app=warm-store-seed").items:
            pvc = (job.metadata.labels or {}).get(LBL_WARM_PVC)
            if not pvc:
                continue
            st = job.status
            if st is not None and (st.succeeded or 0) >= 1:
                out[pvc] = "succeeded"
            elif st is not None and (st.failed or 0) >= 1:
                out[pvc] = "failed"
            else:
                out[pvc] = "running"
        return out

    def list_sandboxes(self) -> list[SandboxRef]:
        """Per-conversation Sandboxes, into the pure SandboxRef shape. `clean_unmount` is
        resolved from the clean-shutdown marker on a suspended sandbox's PVC (see
        read_clean_marker) — only meaningful when suspended."""
        _, custom, _, _ = _apis()
        resp = custom.list_namespaced_custom_object(
            SANDBOX_GROUP, SANDBOX_VERSION, self.namespace, SANDBOX_PLURAL
        )
        out: list[SandboxRef] = []
        for cr in resp.get("items", []):
            conv_id, image_tag = self._sandbox_identity(cr)
            suspended = (cr.get("spec", {}).get("operatingMode", "Running") != "Running")
            clean = self.read_clean_marker(conv_id) if suspended else True
            out.append(
                SandboxRef(conv_id=conv_id, image_tag=image_tag, suspended=suspended, clean_unmount=clean)
            )
        return out

    def read_clean_marker(self, conv_id: str) -> bool:
        """True iff the sandbox left its clean-shutdown marker on the claimed PVC (graceful
        stop). The overlay upper is RWO + single-attach, so the marker can't be read while a
        pod holds it — this is only called AFTER the pod is gone (bound_to_pod False). We read
        it by finding the pool PVC claimed by this conv and checking for the marker via a
        short-lived reader pod that mounts it RO.

        The reader-pod round-trip is I/O-heavy; the loop only calls this for a suspended conv
        whose PVC is unbound, so it's bounded by the suspend rate. Returns False on any error
        (fail-safe: an unreadable marker is treated as unclean → the PVC is discarded, never
        returned dirty)."""
        pvc = self._pool_pvc_claimed_by(conv_id)
        if pvc is None:
            return False
        try:
            return self._marker_present(pvc)
        except client.ApiException as e:
            logger.warning("clean-marker read for %s failed (treating unclean): %s", conv_id, e)
            return False

    # --- apply -------------------------------------------------------------
    def warm_new(self, image_tag: str) -> None:
        """Create a fresh `warming` PVC + launch a warm Job that boots the sandbox image,
        builds warm_golden_expr into the overlay upper, then powers off. On Job success the
        loop relabels the PVC `ready`.

        The Job pod:
          - an initContainer writes `<upper>/.warm-request` (the golden expr) to the PVC so
            the image's scooter-warm-store-seed unit fires (it's ConditionPathExists-gated);
          - the sandbox container boots systemd → overlay-store-setup mounts the upper →
            the seed unit builds the golden expr into it, stamps the clean marker, poweroffs.
        RestartPolicy=OnFailure + backoffLimit so a flaky warm retries; a hard failure leaves
        the PVC `warming` (never relabeled `ready`) → GC'd next pass.
        """
        core, _, batch, _ = _apis()
        # A unique-ish suffix without Date/random (kept deterministic-friendly): the pool
        # size is small and the controller is single-writer (leader), so an index derived
        # from the current pool count is adequate; k8s generateName guarantees uniqueness.
        pvc_name_prefix = f"warm-store-{_tag_slug(image_tag)}-"
        pvc = core.create_namespaced_persistent_volume_claim(
            self.namespace,
            client.V1PersistentVolumeClaim(
                metadata=client.V1ObjectMeta(
                    generate_name=pvc_name_prefix,
                    labels={LBL_WARM_STORE: image_tag, LBL_POOL_STATE: "warming"},
                ),
                spec=client.V1PersistentVolumeClaimSpec(
                    access_modes=["ReadWriteOnce"],
                    resources=client.V1ResourceRequirements(requests={"storage": self.overlay_storage}),
                ),
            ),
        )
        pvc_name = pvc.metadata.name
        batch.create_namespaced_job(self.namespace, self._warm_job_manifest(pvc_name, image_tag))

    def _warm_job_manifest(self, pvc_name: str, image_tag: str) -> client.V1Job:
        """The warm Job: initContainer seeds the .warm-request, sandbox container boots +
        warms + poweroffs. See warm_new + modules/sandbox-os/warm-store-seed.nix."""
        upper = "/nix/.scooter-rw"
        expr = self.warm_golden_expr
        init = client.V1Container(
            name="warm-request",
            image="busybox:1.36",
            command=["sh", "-c", f'printf %s "$GOLDEN_EXPR" > {upper}/.warm-request'],
            env=[client.V1EnvVar(name="GOLDEN_EXPR", value=expr)],
            volume_mounts=[client.V1VolumeMount(name="scooter-rw", mount_path=upper)],
        )
        sandbox = client.V1Container(
            name="sandbox",
            image=self.warm_job_image,
            # systemd PID 1 needs a writable cgroup + mount caps for the overlay; matches
            # the per-conversation sandbox securityContext (crun runtimeClass adds the rest).
            security_context=client.V1SecurityContext(
                capabilities=client.V1Capabilities(add=["SYS_ADMIN"])
            ),
            env=[client.V1EnvVar(name="SCOOTER_IMAGE_TAG", value=image_tag)],
            volume_mounts=[
                client.V1VolumeMount(name="scooter-rw", mount_path=upper),
                client.V1VolumeMount(name="run", mount_path="/run"),
                client.V1VolumeMount(name="tmp", mount_path="/tmp"),
            ],
        )
        return client.V1Job(
            metadata=client.V1ObjectMeta(
                generate_name=f"warm-{_tag_slug(image_tag)}-",
                # LBL_WARM_PVC links this Job to the PVC it warms so the loop can resolve each
                # warming PVC's Job terminal state (→ promote to ready / discard on failure).
                labels={LBL_WARM_STORE: image_tag, LBL_WARM_PVC: pvc_name, "app": "warm-store-seed"},
            ),
            spec=client.V1JobSpec(
                backoff_limit=2,
                # Give the warm build room; the controller GCs a stuck warming PVC anyway.
                active_deadline_seconds=1800,
                ttl_seconds_after_finished=300,
                template=client.V1PodTemplateSpec(
                    metadata=client.V1ObjectMeta(labels={"app": "warm-store-seed"}),
                    spec=client.V1PodSpec(
                        restart_policy="OnFailure",
                        # crun (or whatever the sandboxes use) so systemd PID 1 gets its writable
                        # cgroup subtree in a PRIVATE cgroup ns — not privileged (which would let
                        # it churn the host /kubepods tree → node destabilization). None → default.
                        runtime_class_name=self.runtime_class or None,
                        init_containers=[init],
                        containers=[sandbox],
                        volumes=[
                            client.V1Volume(
                                name="scooter-rw",
                                persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(
                                    claim_name=pvc_name
                                ),
                            ),
                            client.V1Volume(name="run", empty_dir=client.V1EmptyDirVolumeSource(medium="Memory")),
                            client.V1Volume(name="tmp", empty_dir=client.V1EmptyDirVolumeSource(medium="Memory")),
                        ],
                    ),
                ),
            ),
        )

    def relabel(self, pvc: str, state: str, labels: dict[str, str | None]) -> None:
        """Patch a pool PVC's labels (set pool-state + any extras; a None value REMOVES the
        label — a JSON-merge-patch null on metadata.labels)."""
        core, _, _, _ = _apis()
        patch_labels: dict[str, str | None] = {LBL_POOL_STATE: state, **labels}
        core.patch_namespaced_persistent_volume_claim(
            pvc, self.namespace, {"metadata": {"labels": patch_labels}}
        )

    def delete_pvc(self, pvc: str) -> None:
        """Delete a pool PVC (GC / unclean return / LRU evict). 404-tolerant."""
        core, _, _, _ = _apis()
        try:
            core.delete_namespaced_persistent_volume_claim(pvc, self.namespace)
        except client.ApiException as e:
            if e.status != 404:
                raise

    # --- helpers -----------------------------------------------------------
    def _claim_names_bound_to_live_pods(self) -> set[str]:
        """PVC names currently mounted by a non-terminal pod (the RWO single-attach truth —
        a claimed PVC is only reclaimable once no pod holds it)."""
        core, _, _, _ = _apis()
        bound: set[str] = set()
        for pod in core.list_namespaced_pod(self.namespace).items:
            if pod.status and pod.status.phase in ("Succeeded", "Failed"):
                continue
            for vol in pod.spec.volumes or []:
                if vol.persistent_volume_claim is not None:
                    bound.add(vol.persistent_volume_claim.claim_name)
        return bound

    def _pool_pvc_claimed_by(self, conv_id: str) -> str | None:
        """Name of the pool PVC claimed by this conversation, or None."""
        core, _, _, _ = _apis()
        sel = f"{LBL_POOL_STATE}=claimed,{LBL_CLAIMED_BY}={conv_id}"
        items = core.list_namespaced_persistent_volume_claim(self.namespace, label_selector=sel).items
        return items[0].metadata.name if items else None

    def _marker_present(self, pvc: str) -> bool:
        """Check for CLEAN_MARKER_PATH on `pvc` via a short-lived reader pod that mounts it
        RO and tests the file. Returns the pod's success (marker present) / failure."""
        _, _, batch, _ = _apis()
        job = client.V1Job(
            metadata=client.V1ObjectMeta(generate_name="warm-marker-check-"),
            spec=client.V1JobSpec(
                backoff_limit=0,
                ttl_seconds_after_finished=60,
                active_deadline_seconds=60,
                template=client.V1PodTemplateSpec(
                    spec=client.V1PodSpec(
                        restart_policy="Never",
                        containers=[
                            client.V1Container(
                                name="check",
                                image="busybox:1.36",
                                command=["sh", "-c", f"test -f {CLEAN_MARKER_PATH}"],
                                volume_mounts=[
                                    client.V1VolumeMount(name="up", mount_path="/nix/.scooter-rw", read_only=True)
                                ],
                            )
                        ],
                        volumes=[
                            client.V1Volume(
                                name="up",
                                persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(
                                    claim_name=pvc, read_only=True
                                ),
                            )
                        ],
                    )
                ),
            ),
        )
        created = batch.create_namespaced_job(self.namespace, job)
        # The loop polls the Job to Complete/Failed; kept simple here (the caller is off the
        # hot path). A Complete Job == marker present; Failed == absent/unclean.
        return _job_succeeded(created.metadata.name, self.namespace)

    def _sandbox_identity(self, cr: dict) -> tuple[str, str]:
        """(conv_id, image_tag) for a Sandbox CR. conv_id == the Sandbox NAME (what the
        provisioner uses for the pooled PVC's claimed-by label); image_tag == the tag portion
        of the sandbox container image ref."""
        name = cr["metadata"]["name"]
        image = ""
        try:
            image = cr["spec"]["podTemplate"]["spec"]["containers"][0]["image"]
        except (KeyError, IndexError, TypeError):
            pass
        return name, _tag_of(image)


# --- module-level pure helpers (unit-testable without k8s) ------------------

def _tag_of(image_ref: str) -> str:
    """The tag portion of an OCI ref — the part after the LAST ':' that isn't a port. Mirrors
    the kubenix `lib.last (splitString ":" ...)` so the controller and the module agree on the
    version key. A ref with no tag → "" (won't match any warmed PVC → falls back to a fresh vct)."""
    if not image_ref:
        return ""
    # Strip any digest first; then the last ':' segment is the tag (a registry :port has a '/'
    # after it, so a segment containing '/' is not a tag).
    ref = image_ref.split("@", 1)[0]
    last = ref.rsplit(":", 1)
    if len(last) == 2 and "/" not in last[1]:
        return last[1]
    return ""


def _tag_slug(image_tag: str) -> str:
    """A DNS-1123-safe slug of an image tag for PVC/Job names (tags can carry '.', '_', etc.).
    Lowercase alnum + '-'; collapse the rest to '-'; trim; bound length."""
    out = []
    for ch in image_tag.lower():
        out.append(ch if (ch.isalnum() or ch == "-") else "-")
    slug = "".join(out).strip("-")[:40].strip("-")
    return slug or "untagged"


def _job_succeeded(name: str, namespace: str, timeout_s: float = 60.0, clock=time) -> bool:
    """Poll a Job to terminal state; True iff it Completed (succeeded). False on Failed/timeout.
    Used by the marker-check reader Job (a Complete run == the marker file is present)."""
    _, _, batch, _ = _apis()
    deadline = clock.time() + timeout_s
    while clock.time() < deadline:
        st = batch.read_namespaced_job_status(name, namespace).status
        if st is not None and (st.succeeded or 0) >= 1:
            return True
        if st is not None and (st.failed or 0) >= 1:
            return False
        clock.sleep(1.5)
    return False
