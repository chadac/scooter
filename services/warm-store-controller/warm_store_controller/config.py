"""Controller configuration. A plain value dataclass; `Config.from_env()` reads it from
the environment (kept explicit rather than in dataclass defaults, so the value type has no
I/O and is trivial to construct in tests)."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Config:
    """Runtime configuration for the warm-store controller.

    :param namespace: k8s namespace the controller watches (pool PVCs + Sandboxes).
    :param current_image_tag: the sandbox image content tag NEW conversations get — the
        version the pool keeps warm (PVCs of any other tag are GC'd).
    :param min_ready: top up until this many `ready` PVCs exist for current_image_tag.
    :param max_total: cap total `ready` pool PVCs for the current tag (LRU-evict past this).
    :param warm_job_image: the sandbox image the warm Job boots (== current_image_tag ref).
    :param warm_golden_expr: a Nix expression the warm Job builds/installs into the overlay
        (the golden seed). Empty ⇒ a minimal warm (just a valid empty upper).
    :param overlay_storage: size of each pool PVC (the overlay upper).
    :param reconcile_interval: seconds between reconcile passes (also the lease renew cadence
        — must be comfortably < lease_seconds).
    :param lease_seconds: leader-election Lease duration; renew within this window or lose it.
    :param lease_name: name of the shared leader-election Lease (same across replicas).
    :param identity: this replica's lease holder identity — the downward-API pod name.
    """

    namespace: str = "agent-sandbox"
    current_image_tag: str = ""
    min_ready: int = 1
    max_total: int = 8
    warm_job_image: str = ""
    warm_golden_expr: str = ""
    overlay_storage: str = "20Gi"
    reconcile_interval: float = 10.0
    lease_seconds: int = 30
    lease_name: str = "warm-store-controller-leader"
    identity: str = "unknown"

    @classmethod
    def from_env(cls) -> "Config":
        """Build a Config from environment variables (the in-cluster path)."""
        sandbox_image = os.environ.get("SANDBOX_IMAGE", "")
        # The pool version key is the sandbox image's TAG. DERIVE it from SANDBOX_IMAGE (the
        # same ref the provisioner runs imageTagOf() on) so the controller and provisioner
        # ALWAYS agree — even when the deploy rewrites the image ref (…:latest → …:git-<sha>)
        # without touching a separately-computed tag env. SANDBOX_IMAGE_TAG is an explicit
        # override only. (Fixes a deploy tag-mismatch: kubenix computed the tag from
        # cfg.sandboxImage=…:latest, but the deploy sed rewrote the REF to …:git-<sha>, so
        # the controller keyed the pool by "latest" while the provisioner claimed by the sha.)
        from .k8s import _tag_of
        current_image_tag = os.environ.get("SANDBOX_IMAGE_TAG", "") or _tag_of(sandbox_image)
        return cls(
            namespace=os.environ.get("NAMESPACE", "agent-sandbox"),
            current_image_tag=current_image_tag,
            min_ready=int(os.environ.get("WARM_STORE_MIN_READY", "1")),
            max_total=int(os.environ.get("WARM_STORE_MAX_TOTAL", "8")),
            warm_job_image=sandbox_image,
            warm_golden_expr=os.environ.get("WARM_STORE_GOLDEN_EXPR", ""),
            overlay_storage=os.environ.get("WARM_STORE_STORAGE", "20Gi"),
            reconcile_interval=float(os.environ.get("RECONCILE_INTERVAL_SECONDS", "10")),
            lease_seconds=int(os.environ.get("LEASE_DURATION_SECONDS", "30")),
            lease_name=os.environ.get("LEASE_NAME", "warm-store-controller-leader"),
            identity=os.environ.get("POD_NAME", "unknown"),
        )
