"""Thin k8s access for the warm-store controller — pool PVCs (by label), per-conversation
Sandboxes, the clean-shutdown marker, warm Jobs, and the leader-election Lease. Mirrors the
broker's `_apis()` singleton + 409/404 tolerance (services/broker/broker/sandbox/k8s.py).

Pure decisions live in reconcile.py; this is the imperative shell the LOOP uses.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from collections.abc import Iterator
from dataclasses import dataclass

from kubernetes import client, config

from .logging_config import format_error
from .allocate import (
    ANN_LAST_SANDBOX,
    ANN_LAST_USED,
    LBL_WARM_STORE,
    Node,
    PendingSandbox,
    PoolPv,
)
from .reconcile import PoolPvc, SandboxRef, WarmJobStatus

logger = logging.getLogger("k8s")

# Sandbox CR coordinates (agent-sandbox upstream, v1beta1).
SANDBOX_GROUP = "agents.x-k8s.io"
SANDBOX_VERSION = "v1beta1"
SANDBOX_PLURAL = "sandboxes"

# Pool PVC labels (see todo/docs/WARM_STORE_PVC_MANAGER.md). LBL_WARM_STORE / ANN_LAST_USED
# / ANN_LAST_SANDBOX are imported from allocate.py — ONE definition shared by the PVC layer
# and the PV layer, so the two can never drift apart on the key that identifies a pool
# volume.
LBL_POOL_STATE = "scooter.io/pool-state"   # warming|ready|claimed|retiring
LBL_CLAIMED_BY = "scooter.io/claimed-by"   # conv id when claimed
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
    # StorageClass for POOL volumes. MUST have reclaimPolicy: Retain — with the default
    # Delete class, removing a PVC destroys its PV and nothing is ever recycled, so the
    # whole reuse model silently degrades to "always a fresh empty upper".
    pool_storage_class: str = ""

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
                    # A PVC mid-deletion still lists (its finalizer holds it) with its labels
                    # intact — reconcile must recognise it as already-resolved and not re-act.
                    terminating=pvc.metadata.deletion_timestamp is not None,
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
            marker = self.read_unmount_marker(conv_id) if suspended else "clean"
            out.append(
                SandboxRef(conv_id=conv_id, image_tag=image_tag, suspended=suspended, unmount_marker=marker)
            )
        return out

    def read_unmount_marker(self, conv_id: str) -> str:
        """Resolve the overlay's clean-shutdown marker on a suspended conv's claimed PVC, as a
        TRI-STATE: "clean" (marker present), "unclean" (the check ran and the marker was
        DEFINITIVELY absent), or "unknown" (could not determine). The overlay upper is RWO +
        single-attach, so the marker can't be read while a pod holds it — this is only called
        after the pod is gone.

        A failure to READ is NOT evidence the volume is dirty, so it maps to "unknown" (the loop
        then backs off and retries, never deletes). Two "unknown" cases matter especially:
          - the PVC is already TERMINATING: we must NOT spawn a marker-check Job against it (that
            Job can never schedule — the claim is being deleted — so it would time out and, under
            the old code, be misread as "unclean" → another delete → the self-sustaining spin);
          - the claimed PVC can't be found: nothing to read, and nothing to delete.
        """
        pvc = self._pool_pvc_claimed_by(conv_id)
        if pvc is None:
            # Can't locate the claim → cannot decide, and there is nothing to return/discard.
            return "unknown"
        if pvc.metadata.deletion_timestamp is not None:
            # Already being deleted — do NOT create a doomed marker-check Job; it is resolved.
            logger.info(
                "clean-marker skipped: claim is terminating",
                extra={"conversation_id": conv_id, "pvc": pvc.metadata.name},
            )
            return "unknown"
        try:
            return self._marker_result(pvc.metadata.name)
        except client.ApiException as e:
            logger.warning(
                "clean-marker read failed; treating as UNKNOWN (backing off, not deleting)",
                extra={"conversation_id": conv_id, "pvc": pvc.metadata.name, "error": format_error(e)},
            )
            return "unknown"

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

    # --- PV placement (the controller owns volumes end to end) -------------
    # The agent-host no longer claims anything: it always attaches the scooter-rw vct, so
    # placement happens at the PV<->PVC binding layer. We pre-create the PVC under the name
    # the vct WILL generate, pre-bound to a PV via claimRef, and the vct adopts it.
    # See todo/draft/WARM_STORE_PV_OWNERSHIP.md.

    def iter_pool_pvs(self) -> Iterator[PoolPv]:
        """Pool PVs (carrying the warm-store label), MOST-RECENTLY-USED FIRST.

        A GENERATOR so a caller that only needs the first usable candidate stops there
        instead of converting the whole pool. Placement is exactly that shape: rank, take
        the best match, done.

        MRU, not LRU. Spreading load across the pool (LRU) keeps every volume marginally
        warm and none of them properly warm, and leaves nothing safely reapable. Preferring
        the most recently used concentrates reuse onto a small hot set — those volumes get
        genuinely warm, and the cold tail goes untouched long enough to be reaped on age
        alone. The pool converges on "a few well-warmed volumes" rather than "many
        lukewarm ones".

        Sorting is CLIENT-side by necessity: the k8s API has no server-side sort, and PVs
        accept only metadata.name/namespace as field selectors (status.phase is rejected),
        so there is nothing to push down. The listing is bounded by maxTotal, so this is a
        sort of tens of items, not a scan.

        Recency key: our own last-used annotation when present (it tracks ALLOCATION, which
        is what we actually care about), else status.lastPhaseTransitionTime, which k8s
        maintains and which at least orders by when the volume last changed hands. Neither
        present sorts last — an unknown-age volume is the least attractive to reuse and the
        most attractive to reap.

        nodeAffinity is passed through VERBATIM rather than interpreted here — the pure
        core evaluates it, and the shape is identical across drivers (local-path keys on
        kubernetes.io/hostname, EBS on topology.ebs.csi.aws.com/zone)."""
        core, _, _, _ = _apis()
        items = list(core.list_persistent_volume(label_selector=LBL_WARM_STORE).items)
        items.sort(key=self._recency_key, reverse=True)
        for pv in items:
            meta, spec = pv.metadata, pv.spec
            labels = meta.labels or {}
            annotations = meta.annotations or {}
            terms: list[dict] = []
            na = getattr(spec, "node_affinity", None)
            required = getattr(na, "required", None) if na else None
            for term in (getattr(required, "node_selector_terms", None) or []):
                terms.append(
                    {
                        "matchExpressions": [
                            {"key": e.key, "operator": e.operator, "values": list(e.values or [])}
                            for e in (term.match_expressions or [])
                        ],
                        "matchFields": [
                            {"key": e.key, "operator": e.operator, "values": list(e.values or [])}
                            for e in (getattr(term, "match_fields", None) or [])
                        ],
                    }
                )
            yield PoolPv(
                name=meta.name,
                image_tag=labels.get(LBL_WARM_STORE, ""),
                phase=(pv.status.phase if pv.status else "") or "",
                node_selector_terms=terms,
                last_used=annotations.get(ANN_LAST_USED),
                last_sandbox=annotations.get(ANN_LAST_SANDBOX),
                claim_ref=(spec.claim_ref.name if spec.claim_ref else None),
                terminating=meta.deletion_timestamp is not None,
            )

    @staticmethod
    def _recency_key(pv) -> str:
        """When this PV was last handed out. Our annotation first (it tracks ALLOCATION),
        then k8s's phase-transition time, then "" — unknown sorts oldest under reverse."""
        annotations = (pv.metadata.annotations or {})
        stamp = annotations.get(ANN_LAST_USED)
        if stamp:
            return stamp
        transition = getattr(pv.status, "last_phase_transition_time", None) if pv.status else None
        if transition is None:
            return ""
        # rfc3339 strings sort lexicographically; datetimes need normalising to the same.
        return transition if isinstance(transition, str) else transition.strftime("%Y-%m-%dT%H:%M:%SZ")

    def list_pool_pvs(self) -> list[PoolPv]:
        """Materialised iter_pool_pvs, for callers that genuinely need the whole pool
        (reclaim sweeps every Released volume; placement does not)."""
        return list(self.iter_pool_pvs())

    def list_nodes(self) -> list[Node]:
        """Schedulable nodes, reduced to the labels a PV's nodeAffinity can match on.

        `schedulable` excludes cordoned nodes: a PV pinned to a cordoned node is NOT usable,
        and offering it would place a pod that can never schedule — the exact wedge this
        redesign removes."""
        core, _, _, _ = _apis()
        out: list[Node] = []
        for n in core.list_node().items:
            unschedulable = bool(getattr(n.spec, "unschedulable", False))
            out.append(
                Node(name=n.metadata.name, labels=n.metadata.labels or {}, schedulable=not unschedulable)
            )
        return out

    def list_pending_uppers(self) -> list[PendingSandbox]:
        """Running Sandboxes whose `scooter-rw` PVC does not exist yet — the ones we can
        still place a warm PV for.

        Timing is everything: once the vct has provisioned, the PVC exists and the decision
        is made. We only act in the window before that. Missing the window is harmless — the
        conversation gets a fresh empty upper, which is the designed fallback."""
        core, custom, _, _ = _apis()
        existing = {
            pvc.metadata.name
            for pvc in core.list_namespaced_persistent_volume_claim(self.namespace).items
        }
        resp = custom.list_namespaced_custom_object(
            SANDBOX_GROUP, SANDBOX_VERSION, self.namespace, SANDBOX_PLURAL
        )
        out: list[PendingSandbox] = []
        for cr in resp.get("items", []):
            if (cr.get("spec", {}).get("operatingMode", "Running") != "Running"):
                continue
            name, image_tag = self._sandbox_identity(cr)
            # Only Sandboxes that actually declare a scooter-rw vct want an upper.
            vcts = cr.get("spec", {}).get("volumeClaimTemplates") or []
            if not any((v.get("metadata") or {}).get("name") == "scooter-rw" for v in vcts):
                continue
            pvc_name = f"scooter-rw-{name}"
            if pvc_name in existing:
                continue  # already provisioned or already placed
            out.append(PendingSandbox(sandbox=name, image_tag=image_tag, pvc_name=pvc_name))
        return out

    def reserve_pv(self, pv: str, pvc_name: str, sandbox: str) -> None:
        """Pre-bind `pv` to `pvc_name` and create that PVC so the vct adopts it.

        Order matters. claimRef FIRST: it reserves the PV for exactly this one claim, so no
        other PVC can bind it in the gap. Only then create the PVC. Reversed, the PVC could
        bind some other volume before we point it at ours.

        The PVC is created WITHOUT ownerReferences deliberately — a vct-adopted PVC gets
        none either (verified), and the controller owns this volume's lifetime via the PV
        finalizer, not via k8s GC."""
        core, _, _, _ = _apis()
        core.patch_persistent_volume(
            pv,
            {
                "spec": {"claimRef": {"namespace": self.namespace, "name": pvc_name}},
                "metadata": {
                    "annotations": {
                        ANN_LAST_SANDBOX: sandbox,
                        ANN_LAST_USED: _now_rfc3339(),
                    }
                },
            },
        )
        # 409 = a prior pass already created it (or the vct just did). Either way the name
        # is taken by the claim we want; the claimRef above decides which PV it gets.
        try:
            core.create_namespaced_persistent_volume_claim(
                self.namespace,
                client.V1PersistentVolumeClaim(
                    metadata=client.V1ObjectMeta(
                        name=pvc_name,
                        labels={LBL_WARM_STORE: self._pv_tag(pv)},
                    ),
                    spec=client.V1PersistentVolumeClaimSpec(
                        access_modes=["ReadWriteOnce"],
                        resources=client.V1ResourceRequirements(requests={"storage": self.overlay_storage}),
                        storage_class_name=self.pool_storage_class,
                        volume_name=pv,
                    ),
                ),
            )
        except client.ApiException as e:
            if e.status != 409:
                raise

    def release_pv(self, pv: str) -> None:
        """Return `pv` to the pool by clearing spec.claimRef.

        Used for BOTH recycling a Released PV and rolling back a reservation that did not
        work out. A Released PV still names its late PVC, and k8s will not rebind it while
        that dangling reference stands — so without this the pool silently stops recycling
        and every wake falls through to a fresh empty upper."""
        core, _, _, _ = _apis()
        try:
            core.patch_persistent_volume(pv, {"spec": {"claimRef": None}})
        except client.ApiException as e:
            if e.status != 404:
                raise

    def _pv_tag(self, pv: str) -> str:
        """The image tag a PV was warmed against, read back for the PVC's label."""
        core, _, _, _ = _apis()
        try:
            obj = core.read_persistent_volume(pv)
        except client.ApiException:
            return ""
        return (obj.metadata.labels or {}).get(LBL_WARM_STORE, "")

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

    def _pool_pvc_claimed_by(self, conv_id: str):
        """The pool PVC object claimed by this conversation, or None. Returns the object (not
        just the name) so callers can inspect metadata.deletion_timestamp (terminating?)."""
        core, _, _, _ = _apis()
        sel = f"{LBL_POOL_STATE}=claimed,{LBL_CLAIMED_BY}={conv_id}"
        items = core.list_namespaced_persistent_volume_claim(self.namespace, label_selector=sel).items
        return items[0] if items else None

    def _marker_result(self, pvc: str) -> str:
        """Check for CLEAN_MARKER_PATH on `pvc` via a short-lived reader Job that mounts it RO
        and tests the file. TRI-STATE: "clean" (Job Completed → marker present), "unclean" (Job
        Failed → the file was definitively absent), "unknown" (the Job never reached a terminal
        state within the deadline — e.g. it could not schedule). Only a DEFINITIVE Failed maps
        to unclean; a timeout is unknown so the loop backs off instead of destroying the PVC."""
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
        # hot path). Complete → marker present (clean); Failed → absent (unclean); neither
        # within the deadline → unknown (back off, do not delete).
        return {"succeeded": "clean", "failed": "unclean"}.get(
            _job_result(created.metadata.name, self.namespace), "unknown"
        )

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

def _now_rfc3339() -> str:
    """UTC rfc3339, for the last-used LRU stamp."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


def _job_result(name: str, namespace: str, timeout_s: float = 60.0, clock=time) -> str:
    """Poll a Job to terminal state as a TRI-STATE: "succeeded" (Completed), "failed"
    (definitively Failed), or "unknown" (neither within the deadline — e.g. the pod could not
    schedule because its claim is terminating). Used by the marker-check reader Job: a timeout
    must NOT be read as "failed" (which the caller maps to unclean → delete) — it is unknown, so
    the caller backs off instead of destroying a volume it never actually inspected."""
    _, _, batch, _ = _apis()
    deadline = clock.time() + timeout_s
    while clock.time() < deadline:
        st = batch.read_namespaced_job_status(name, namespace).status
        if st is not None and (st.succeeded or 0) >= 1:
            return "succeeded"
        if st is not None and (st.failed or 0) >= 1:
            return "failed"
        clock.sleep(1.5)
    return "unknown"
