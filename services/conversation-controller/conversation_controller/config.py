"""Controller configuration (env). Minimal — namespace, per-pod cap, timing, identity."""

from __future__ import annotations

import os


class Config:
    def __init__(self) -> None:
        self.namespace = os.environ.get("NAMESPACE", "agent-sandbox")
        # Max Conversations assigned to one agent-host pod before it's considered full.
        self.pod_cap = int(os.environ.get("CONVERSATION_POD_CAP", "100"))
        # Reconcile cadence + lease timing (seconds).
        self.reconcile_interval = float(os.environ.get("RECONCILE_INTERVAL_SECONDS", "5"))
        self.lease_seconds = int(os.environ.get("LEASE_DURATION_SECONDS", "15"))
        self.lease_name = os.environ.get("LEASE_NAME", "conversation-controller-leader")
        # This pod's identity for the lease (the downward-API pod name in-cluster).
        self.identity = os.environ.get("POD_NAME") or os.environ.get("HOSTNAME", "unknown")
