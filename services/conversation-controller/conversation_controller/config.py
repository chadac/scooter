"""Controller configuration. A plain value dataclass; `Config.from_env()` reads it from
the environment (kept explicit rather than in dataclass defaults, so the value type has
no I/O and is trivial to construct in tests)."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Config:
    """Runtime configuration for the controller.

    :param namespace: k8s namespace the controller watches (its own + the Conversations).
    :param pod_cap: max Conversations assigned to ONE agent-host pod before it's treated
        as full (a new conversation then waits Pending until a pod has room).
    :param reconcile_interval: seconds between reconcile passes (also the lease renew
        cadence — must be comfortably < lease_seconds).
    :param lease_seconds: leader-election Lease duration; the holder must renew within
        this window or another replica may take over.
    :param lease_name: name of the shared leader-election Lease (same across replicas).
    :param identity: this replica's lease holder identity — the downward-API pod name.
    """

    namespace: str = "agent-sandbox"
    pod_cap: int = 100
    reconcile_interval: float = 5.0
    lease_seconds: int = 15
    lease_name: str = "conversation-controller-leader"
    identity: str = "unknown"
    # Orphaned-Sandbox reaper: destroy Sandboxes with no owning Conversation, older than the
    # grace window (spares a just-created Sandbox whose CR isn't registered yet). On by
    # default; grace defaults to 10 min. See todo/docs/ORPHANED_SANDBOX_REAPER.md.
    reap_orphans: bool = True
    orphan_grace_seconds: float = 600.0

    @classmethod
    def from_env(cls) -> "Config":
        """Build a Config from environment variables (the in-cluster path)."""
        return cls(
            namespace=os.environ.get("NAMESPACE", "agent-sandbox"),
            pod_cap=int(os.environ.get("CONVERSATION_POD_CAP", "100")),
            reconcile_interval=float(os.environ.get("RECONCILE_INTERVAL_SECONDS", "5")),
            lease_seconds=int(os.environ.get("LEASE_DURATION_SECONDS", "15")),
            lease_name=os.environ.get("LEASE_NAME", "conversation-controller-leader"),
            # The downward-API pod name in-cluster; HOSTNAME is the container fallback.
            identity=os.environ.get("POD_NAME") or os.environ.get("HOSTNAME", "unknown"),
            reap_orphans=os.environ.get("REAP_ORPHANED_SANDBOXES", "1") != "0",
            orphan_grace_seconds=float(os.environ.get("ORPHAN_GRACE_SECONDS", "600")),
        )
