"""Controller configuration: a plain value dataclass that `Config.from_env()` reads from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Config:
    """Runtime configuration for the controller.

    :param namespace: the k8s namespace the controller and the Conversations live in.
    :param pod_cap: max Conversations assigned to one agent-host pod before it is full.
    :param reconcile_interval: seconds between reconcile passes, which must stay well under lease_seconds.
    :param lease_seconds: leader-election Lease duration the holder must renew within.
    :param lease_name: name of the leader-election Lease shared across replicas.
    :param identity: this replica's lease holder identity, the downward-API pod name.
    """

    namespace: str = "agent-sandbox"
    pod_cap: int = 100
    reconcile_interval: float = 5.0
    lease_seconds: int = 15
    lease_name: str = "conversation-controller-leader"
    identity: str = "unknown"
    # Orphaned-Sandbox reaper: Sandboxes with no owning Conversation are destroyed once older
    # than the grace window.
    reap_orphans: bool = True
    orphan_grace_seconds: float = 600.0
    # Delete overlay-store PVCs suspended this long; 0 disables.
    overlay_retention_seconds: float = 7 * 86400.0
    # Delete an idle, suspended, unstarred root sandbox after this long; 0 disables.
    sandbox_retention_seconds: float = 28 * 86400.0
    # Agent-host autoscaling: the controller scales the agent-host Deployment to fit demand, so
    # no HPA may also write its replicas.
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
            identity
=os.environ.get("POD_NAME") or os.environ.get("HOSTNAME", "unknown"),
            reap_orphans=os.environ.get("REAP_ORPHANED_SANDBOXES", "1") != "0",
            orphan_grace_seconds=float(os.environ.get("ORPHAN_GRACE_SECONDS", "600")),
            overlay_retention_seconds=float(os.environ.get("OVERLAY_RETENTION_SECONDS", str(7 * 86400))),
            sandbox_retention_seconds=float(os.environ.get("SANDBOX_RETENTION_SECONDS", str(28 * 86400))),
            autoscale=os.environ.get("AUTOSCALE_AGENT_HOST", "1") != "0",
            min_replicas=int(os.environ.get("AGENT_HOST_MIN_REPLICAS", "2")),
            max_replicas=int(os.environ.get("AGENT_HOST_MAX_REPLICAS", "10")),
            scale_down_cooldown_seconds=float(os.environ.get("SCALE_DOWN_COOLDOWN_SECONDS", "300")),
            metrics_port=int(os.environ.get("METRICS_PORT", "9090")),
        )
