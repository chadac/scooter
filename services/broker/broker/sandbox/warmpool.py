"""Warm /nix/store PVC pool (skeleton — PR 1).

A pool of pre-warmed RWO PVCs, each carrying a populated overlay UPPER (`upper/` +
`state/`) so a new conversation finds common tools already built instead of rebuilding.

KEY = the sandbox IMAGE CONTENT TAG (== the overlay lower's identity). The round-trip
spike (todo/docs/spikes/warm-store-roundtrip-mwe.sh) proved a warmed upper reused over
the SAME lower needs NO mount-time DB fixup, and dangles over a DIFFERENT lower — so a
PVC is only ever handed to a sandbox whose image tag matches. State lives in labels:

    scooter.warm-store/image-tag=<tag>
    scooter.warm-store/state=warming|ready|claimed

RWO single-attach discipline: a PVC becomes `ready` ONLY after its warm Job completes,
so the warm Job and a claimant never hold the volume at once.

SKELETON scope: lazy warm-on-demand, ONE golden tool, label-swap claim, no GC/LRU.
Off unless `deploy.warm_store_pool`. See todo/docs/WARM_STORE_POOL_PR1.md.
"""

from __future__ import annotations

from dataclasses import dataclass

from kubernetes import client, config

from .manifest import DeployConfig

LABEL_TAG = "scooter.warm-store/image-tag"
LABEL_STATE = "scooter.warm-store/state"
# The overlay's writable upper mount point (must match overlay-store.nix upperPath).
UPPER_PATH = "/nix/.scooter-rw"

_core: client.CoreV1Api | None = None
_batch: client.BatchV1Api | None = None


def _apis() -> tuple[client.CoreV1Api, client.BatchV1Api]:
    global _core, _batch
    if _core is None or _batch is None:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        _core = client.CoreV1Api()
        _batch = client.BatchV1Api()
    return _core, _batch


def _pvc_name(tag: str, suffix: str) -> str:
    # Deterministic-ish; the suffix disambiguates multiple warm PVCs of one tag.
    return f"warm-store-{tag}-{suffix}"


def _job_name(pvc_name: str) -> str:
    return f"{pvc_name}-warm"


@dataclass
class WarmPool:
    """Broker-owned checkout/return pool of warmed overlay-upper PVCs, keyed by image
    content tag. Skeleton: labels ARE the state (no separate DB)."""

    def __init__(self, deploy: DeployConfig) -> None:
        self.deploy = deploy
        self.ns = deploy.namespace
        # A monotonic-ish suffix source for warm PVC names within this process.
        self._n = 0

    # --- claim / return ----------------------------------------------------

    def claim(self, image_tag: str) -> str | None:
        """Find a `ready` PVC for this image tag, flip it to `claimed`, return its name.
        None if the pool has no ready PVC of the tag (caller falls back to a fresh
        volumeClaimTemplate). The label-swap is the exclusivity guard — a second claim
        finds no ready PVC left."""
        core, _ = _apis()
        selector = f"{LABEL_TAG}={image_tag},{LABEL_STATE}=ready"
        lst = core.list_namespaced_persistent_volume_claim(self.ns, label_selector=selector)
        for item in lst.items:
            name = item.metadata.name
            self._set_state(name, "claimed")
            return name
        return None

    def return_(self, pvc_name: str) -> None:
        """Return a claimed PVC to the pool as `ready` (self-enrichment: the agent's
        extra installs stay). No-op-safe if the PVC is gone."""
        self._set_state(pvc_name, "ready")

    # --- warm (producer) ---------------------------------------------------

    def warm(self, image_tag: str) -> str:
        """Create a fresh PVC (labeled `warming`) + launch a warm Job that installs the
        golden tool set into its overlay upper. The PVC becomes `ready` only after the
        Job succeeds (see reconcile). Returns the PVC name."""
        core, batch = _apis()
        self._n += 1
        name = _pvc_name(image_tag, str(self._n))
        core.create_namespaced_persistent_volume_claim(
            self.ns,
            {
                "metadata": {
                    "name": name,
                    "labels": {LABEL_TAG: image_tag, LABEL_STATE: "warming"},
                },
                "spec": {
                    "accessModes": ["ReadWriteOnce"],
                    "resources": {"requests": {"storage": self.deploy.overlay_storage}},
                },
            },
        )
        batch.create_namespaced_job(self.ns, self.warm_job_manifest(name, image_tag))
        return name

    def reconcile(self) -> None:
        """Promote `warming` PVCs whose warm Job has SUCCEEDED to `ready`. Called
        periodically (skeleton: the tests call it directly; a loop wires it later)."""
        core, batch = _apis()
        selector = f"{LABEL_STATE}=warming"
        lst = core.list_namespaced_persistent_volume_claim(self.ns, label_selector=selector)
        for item in lst.items:
            name = item.metadata.name
            job = batch.read_namespaced_job(_job_name(name), self.ns)
            if getattr(job.status, "succeeded", None):
                self._set_state(name, "ready")

    # --- manifests ---------------------------------------------------------

    def warm_job_manifest(self, pvc_name: str, image_tag: str) -> dict:
        """A one-shot Job: the SAME sandbox image (so the lower == the image the warmed
        paths reference), the warm PVC mounted at the overlay upper, and a warm
        entrypoint that installs the golden tool set into upper/ then exits."""
        return {
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": {
                "name": _job_name(pvc_name),
                "namespace": self.ns,
                "labels": {LABEL_TAG: image_tag},
            },
            "spec": {
                "backoffLimit": 1,
                "template": {
                    "metadata": {"labels": {LABEL_TAG: image_tag}},
                    "spec": {
                        "restartPolicy": "Never",
                        "containers": [
                            {
                                "name": "warm",
                                "image": self.deploy.sandbox_image,
                                # SKELETON: install ONE golden tool into the overlay
                                # upper, then exit. The real warm script (a multi-tool
                                # golden set) is a follow-up. `scooter-warm` is the
                                # in-image entrypoint that brings up the overlay + nix.
                                "command": ["/bin/sh", "-lc", "scooter-warm awscli2"],
                                "volumeMounts": [
                                    {"name": "scooter-rw", "mountPath": UPPER_PATH}
                                ],
                            }
                        ],
                        "volumes": [
                            {
                                "name": "scooter-rw",
                                "persistentVolumeClaim": {"claimName": pvc_name},
                            }
                        ],
                    },
                },
            },
        }

    # --- internal ----------------------------------------------------------

    def _set_state(self, pvc_name: str, state: str) -> None:
        core, _ = _apis()
        core.patch_namespaced_persistent_volume_claim(
            pvc_name, self.ns, {"metadata": {"labels": {LABEL_STATE: state}}}
        )
