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
    # Agent-host AUTOSCALING: the controller scales the agent-host Deployment to fit demand
    # (ceil(top-level conversations / pod_cap), clamped to [min,max]). On by default. Do NOT
    # also run an HPA on agent-host replicas (two writers fight). scale_down_cooldown avoids
    # flapping. metrics_port serves a Prometheus /metrics (conversations_per_pod) for
    # observability / a future HPA. See todo/docs/AGENT_HOST_FLEET_SCALING.md.
    autoscale: bool = True
    min_replicas: int = 2
    max_replicas: int = 10
    scale_down_cooldown_seconds: float = 300.0
    metrics_port: int = 9090

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
            autoscale=os.environ.get("AUTOSCALE_AGENT_HOST", "1") != "0",
            min_replicas=int(os.environ.get("AGENT_HOST_MIN_REPLICAS", "2")),
            max_replicas=int(os.environ.get("AGENT_HOST_MAX_REPLICAS", "10")),
            scale_down_cooldown_seconds=float(os.environ.get("SCALE_DOWN_COOLDOWN_SECONDS", "300")),
            metrics_port=int(os.environ.get("METRICS_PORT", "9090")),
        )
