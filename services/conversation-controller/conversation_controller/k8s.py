"""Thin k8s access for the controller — Conversation CRs, agent-host pods, and the
leader-election Lease. Mirrors the broker's `_apis()` singleton + 409/404 tolerance
(services/broker/broker/sandbox/k8s.py)."""

from __future__ import annotations

import logging

from dataclasses import dataclass

from kubernetes import client, config

from .reconcile import Pod

logger = logging.getLogger("conversation-controller")

GROUP = "scooter.chadac.dev"
VERSION = "v1alpha1"
PLURAL = "conversations"
AGENT_HOST_LABEL = "app=agent-host"

_core: client.CoreV1Api | None = None
_custom: client.CustomObjectsApi | None = None
_coord: client.CoordinationV1Api | None = None


def _apis() -> tuple[client.CoreV1Api, client.CustomObjectsApi, client.CoordinationV1Api]:
    global _core, _custom, _coord
    if _core is None:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        _core = client.CoreV1Api()
        _custom = client.CustomObjectsApi()
        _coord = client.CoordinationV1Api()
    assert _core is not None and _custom is not None and _coord is not None
    return _core, _custom, _coord


@dataclass
class ControllerK8s:
    """Imperative k8s ops the reconcile LOOP uses. Pure decisions live in reconcile.py.

    :param namespace: the k8s namespace all operations target (list pods, list/patch
        Conversations) — the controller's own namespace.
    """

    namespace: str

    # --- agent-host pods (assignment targets) ------------------------------
    def list_host_pods(self) -> list[Pod]:
        """READY-ness of every agent-host pod, for pick_host()."""
        core, _, _ = _apis()
        out: list[Pod] = []
        for p in core.list_namespaced_pod(self.namespace, label_selector=AGENT_HOST_LABEL).items:
            ready = _pod_ready(p)
            out.append(Pod(name=p.metadata.name, ready=ready))
        return out

    # --- Conversation CRs --------------------------------------------------
    def list_conversations(self) -> list[dict]:
        _, custom, _ = _apis()
        resp = custom.list_namespaced_custom_object(GROUP, VERSION, self.namespace, PLURAL)
        return resp.get("items", [])

    def patch_status(self, name: str, status: dict) -> None:
        """Patch a Conversation's status subresource (the assignment record)."""
        _, custom, _ = _apis()
        custom.patch_namespaced_custom_object_status(
            GROUP, VERSION, self.namespace, PLURAL, name, {"status": status}
        )


def _pod_ready(pod) -> bool:
    if pod.status is None or pod.status.conditions is None:
        return False
    if pod.status.phase != "Running":
        return False
    for c in pod.status.conditions:
        if c.type == "Ready":
            return c.status == "True"
    return False
