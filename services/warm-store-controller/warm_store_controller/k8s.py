"""Thin k8s access for the warm-store controller — pool PVCs (by label), per-conversation
Sandboxes, the clean-shutdown marker, warm Jobs, and the leader-election Lease. Mirrors the
broker's `_apis()` singleton + 409/404 tolerance (services/broker/broker/sandbox/k8s.py).

Pure decisions live in reconcile.py; this is the imperative shell the LOOP uses.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from kubernetes import client, config

from .reconcile import PoolPvc, SandboxRef

logger = logging.getLogger("warm-store-controller")

# Sandbox CR coordinates (agent-sandbox upstream, v1beta1).
SANDBOX_GROUP = "agents.x-k8s.io"
SANDBOX_VERSION = "v1beta1"
SANDBOX_PLURAL = "sandboxes"

# Pool PVC labels (see todo/docs/WARM_STORE_PVC_MANAGER.md).
LBL_WARM_STORE = "scooter.io/warm-store"   # image content tag (the version key)
LBL_POOL_STATE = "scooter.io/pool-state"   # warming|ready|claimed|retiring
LBL_CLAIMED_BY = "scooter.io/claimed-by"   # conv id when claimed
LBL_LAST_USED = "scooter.io/last-used"     # rfc3339, for LRU
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

    # --- observe -----------------------------------------------------------
    def list_pool_pvcs(self) -> list[PoolPvc]:
        """Every pool PVC (carries a pool-state label), read into the pure PoolPvc shape.
        `bound_to_pod` is derived from a live-pod scan (a pod mounting the claim)."""
        core, _, _, _ = _apis()
        bound = self._claim_names_bound_to_live_pods()
        out: list[PoolPvc] = []
        for pvc in core.list_namespaced_persistent_volume_claim(
            self.namespace, label_selector=POOL_SELECTOR
        ).items:
            labels = pvc.metadata.labels or {}
            out.append(
                PoolPvc(
                    name=pvc.metadata.name,
                    image_tag=labels.get(LBL_WARM_STORE, ""),
                    state=labels.get(LBL_POOL_STATE, ""),
                    claimed_by=labels.get(LBL_CLAIMED_BY),
                    last_used=labels.get(LBL_LAST_USED),
                    bound_to_pod=pvc.metadata.name in bound,
                )
            )
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
        """True iff the sandbox wrote its clean-shutdown marker (graceful stop) newer than the
        claim. DESIGN STAGE — the mechanism (short-lived reader pod / checker sidecar reading
        CLEAN_MARKER_PATH on the PVC) is filled at implementation; tested via the fake."""
        raise NotImplementedError("impl: read the .clean-shutdown marker off the conv's PVC")

    # --- apply -------------------------------------------------------------
    def warm_new(self, image_tag: str) -> None:
        """Create a fresh `warming` PVC + launch a warm Job that boots the sandbox image,
        builds warm_golden_expr into the overlay upper, then exits. On Job success the loop
        relabels the PVC `ready`. DESIGN STAGE — manifest built at implementation."""
        raise NotImplementedError("impl: create warming PVC + warm Job")

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

    @staticmethod
    def _sandbox_identity(cr: dict) -> tuple[str, str]:
        """(conv_id, image_tag) for a Sandbox CR. conv_id == the claimed-by we match on;
        image_tag == the sandbox container image's content tag. DESIGN STAGE — the exact
        label/annotation the provisioner stamps is finalized with the claim hook."""
        raise NotImplementedError("impl: read conv id + image tag off the Sandbox CR")
