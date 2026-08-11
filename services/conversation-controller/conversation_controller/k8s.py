"""Thin k8s access for the controller — Conversation CRs, agent-host pods, and the
leader-election Lease. Mirrors the broker's `_apis()` singleton + 409/404 tolerance
(services/broker/broker/sandbox/k8s.py)."""

from __future__ import annotations

import logging
import os
import threading
import urllib.error
import urllib.request

from dataclasses import dataclass

from kubernetes import client, config

from .reconcile import Pod

logger = logging.getLogger("conversation-controller")

GROUP = "scooter.chadac.dev"
VERSION = "v1alpha1"
PLURAL = "conversations"
AGENT_HOST_LABEL = "app=agent-host"

# agent-host container port + how long to wait on a revive-push before giving up (the push
# is a best-effort pre-warm — the host also revives lazily on the first forwarded request,
# so we must not let a slow/hung host stall the reconcile loop).
#
# NOTE: do NOT name this env AGENT_HOST_PORT — Kubernetes auto-injects a service-link env
# `AGENT_HOST_PORT=tcp://<clusterIP>:8080` for the `agent-host` Service, which would shadow a
# numeric override and crash int(). Use a distinct name.
AGENT_HOST_PORT = int(os.environ.get("REVIVE_TARGET_PORT", "8080"))
REVIVE_TIMEOUT_SECONDS = float(os.environ.get("REVIVE_PUSH_TIMEOUT_SECONDS", "3"))

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
        """Name, READY-ness, and IP of every agent-host pod. The IP is the routing address
        the router proxies to (status.hostIP on the CR); None until the pod is scheduled."""
        core, _, _ = _apis()
        out: list[Pod] = []
        for p in core.list_namespaced_pod(self.namespace, label_selector=AGENT_HOST_LABEL).items:
            ready = _pod_ready(p)
            ip = p.status.pod_ip if p.status is not None else None
            out.append(Pod(name=p.metadata.name, ready=ready, ip=ip))
        return out

    # --- revive-push (seamless rollout) ------------------------------------
    def notify_revive(self, host_ip: str, conv_name: str, generation: int) -> None:
        """Tell the newly-assigned host to revive `conv_name` from the mirror NOW (pre-warm,
        before user traffic). POSTs http://<host_ip>:<AGENT_HOST_PORT>/internal/revive/<name>.

        FIRE-AND-FORGET (runs in a daemon thread): the push MUST NOT block the reconcile
        loop. A stale hostIP (a pod replaced across rollouts) is UNROUTABLE, and a TCP connect
        to an unroutable IP can hang well past urlopen's `timeout` (the timeout bounds each
        socket op, not a black-holed SYN) — a synchronous call there WEDGED the whole reconcile
        pass (observed live on odin: no conversation got assigned). So we return immediately and
        let the thread do the (timeout-bounded) HTTP in the background. Best-effort: the host
        also revives LAZILY on the first forwarded request, so a dropped push is harmless.
        `generation` lets the host fence a stale push.

        Cluster-internal: reaches the pod IP directly on the pod network (the CRD's hostIP).
        """
        url = f"http://{host_ip}:{AGENT_HOST_PORT}/internal/revive/{conv_name}?gen={generation}"

        def _push() -> None:
            req = urllib.request.Request(url, method="POST", data=b"")
            try:
                with urllib.request.urlopen(req, timeout=REVIVE_TIMEOUT_SECONDS) as resp:
                    if resp.status // 100 != 2:
                        logger.warning("revive-push %s -> HTTP %s", url, resp.status)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                # Non-fatal — the host revives lazily on first request as the backstop.
                logger.warning("revive-push to %s failed (lazy revive will cover it): %s", url, e)

        threading.Thread(target=_push, name=f"revive-{conv_name}", daemon=True).start()

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
