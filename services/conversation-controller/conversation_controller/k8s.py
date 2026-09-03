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
from datetime import datetime, timezone

from kubernetes import client, config

from .logging_config import format_error
from .reconcile import Pod, SandboxRef

logger = logging.getLogger(__name__)
_C = {"component": "k8s"}


def _parse_ts(ts: str) -> datetime:
    """Parse a k8s RFC3339 creationTimestamp (…Z) to an aware UTC datetime."""
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _ignore_404(e: client.ApiException) -> None:
    """A 404 means the object is already gone — the delete's goal. Re-raise anything else so
    the reap retries (a swallowed 403/5xx would silently leak)."""
    if e.status != 404:
        raise e

GROUP = "scooter.chadac.dev"
VERSION = "v1alpha1"
PLURAL = "conversations"
AGENT_HOST_LABEL = "app=agent-host"
DELETION_COST_ANNOTATION = "controller.kubernetes.io/pod-deletion-cost"
AGENT_HOST_DEPLOYMENT = "agent-host"  # the Deployment the controller autoscales

# The upstream agent-sandbox Sandbox CR (what the reaper GCs).
SANDBOX_GROUP = "agents.x-k8s.io"
SANDBOX_VERSION = "v1beta1"
SANDBOX_PLURAL = "sandboxes"

# Per-conversation object names, derived from the Sandbox name `conv-<id>` — MUST match the
# agent-host provisioner (saName/moduleCmName in k8sProvisioner.ts). The reaper deletes all
# three because a Sandbox delete cascades its pod + vct PVCs but NOT the SA or module CM.
def _sa_name(sandbox_name: str) -> str:
    return "sandbox-" + sandbox_name.removeprefix("conv-")


def _module_cm_name(sandbox_name: str) -> str:
    return sandbox_name + "-module"

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
_apps: client.AppsV1Api | None = None


def _apis() -> tuple[client.CoreV1Api, client.CustomObjectsApi, client.CoordinationV1Api]:
    global _core, _custom, _coord, _apps
    if _core is None:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        _core = client.CoreV1Api()
        _custom = client.CustomObjectsApi()
        _coord = client.CoordinationV1Api()
        _apps = client.AppsV1Api()
    assert _core is not None and _custom is not None and _coord is not None
    return _core, _custom, _coord


def _apps_api() -> client.AppsV1Api:
    _apis()  # ensure init
    assert _apps is not None
    return _apps


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
            raw = (p.metadata.annotations or {}).get(DELETION_COST_ANNOTATION)
            try:
                cost = int(raw) if raw is not None else None
            except ValueError:
                cost = None
            out.append(Pod(
                name=p.metadata.name,
                ready=ready,
                ip=ip,
                deletion_cost=cost,
                terminating=p.metadata.deletion_timestamp is not None,
            ))
        return out

    def set_pod_deletion_cost(self, name: str, cost: int) -> None:
        """Annotate an agent-host pod with its scale-down deletion cost (see
        reconcile.deletion_costs). 404-tolerant: the pod may be terminating."""
        core, _, _ = _apis()
        body = {"metadata": {"annotations": {DELETION_COST_ANNOTATION: str(cost)}}}
        try:
            core.patch_namespaced_pod(name, self.namespace, body)
        except client.ApiException as e:
            _ignore_404(e)

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
                        logger.warning(
                            "revive-push non-2xx",
                            extra={
                                **_C,
                                "conversation_id": conv_name,
                                "url": url,
                                "http_status": resp.status,
                                "generation": generation,
                            },
                        )
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                # Non-fatal — the host revives lazily on first request as the backstop.
                logger.warning(
                    "revive-push failed",
                    extra={
                        **_C,
                        "conversation_id": conv_name,
                        "url": url,
                        "generation": generation,
                        "fallback": "lazy-revive",
                        # str() on TimeoutError/URLError is often EMPTY — format_error falls
                        # back to repr() + the type name so this line still says something.
                        "error": format_error(e),
                    },
                )

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

    # --- orphaned-Sandbox reaper -------------------------------------------
    def suspend_sandbox(self, name: str) -> None:
        """Set the Sandbox's spec.operatingMode=Suspended (the zombie repair). Merge-patch,
        idempotent; a 404 (sandbox already gone) is fine."""
        _, custom, _ = _apis()
        try:
            custom.patch_namespaced_custom_object(
                group="agents.x-k8s.io", version="v1alpha1", plural="sandboxes",
                namespace=self.namespace, name=name,
                body={"spec": {"operatingMode": "Suspended"}},
            )
        except client.ApiException as e:
            _ignore_404(e)

    def force_delete_sandbox(self, name: str) -> None:
        """Terminal zombie escalation: delete the Sandbox CR outright (cascades its pod + vct
        PVCs) to reclaim a sandbox that refuses to suspend after N bounded attempts. Distinct
        from the reaper's delete_sandbox_tree — the owning Conversation still exists (marked
        Failed by the loop), so we drop ONLY the Sandbox, not its SA / module ConfigMap.
        404-tolerant: already-gone is the goal; a non-404 propagates so the loop retries."""
        _, custom, _ = _apis()
        try:
            custom.delete_namespaced_custom_object(
                SANDBOX_GROUP, SANDBOX_VERSION, self.namespace, SANDBOX_PLURAL, name
            )
        except client.ApiException as e:
            _ignore_404(e)

    def list_sandboxes(self) -> list["SandboxRef"]:
        """Every per-conversation Sandbox, as (name, age_seconds) for the reaper decision."""
        _, custom, _ = _apis()
        resp = custom.list_namespaced_custom_object(
            SANDBOX_GROUP, SANDBOX_VERSION, self.namespace, SANDBOX_PLURAL
        )
        out: list[SandboxRef] = []
        now = datetime.now(timezone.utc)
        for cr in resp.get("items", []):
            name = cr["metadata"]["name"]
            created = cr["metadata"].get("creationTimestamp")
            age = (now - _parse_ts(created)).total_seconds() if created else 0.0
            mode = (cr.get("spec") or {}).get("operatingMode")
            out.append(SandboxRef(name=name, age_seconds=age, operating_mode=mode))
        return out

    def delete_sandbox_tree(self, sandbox_name: str) -> None:
        """Destroy the whole per-conversation tree for an orphaned Sandbox: the Sandbox CR
        (cascades its pod + vct PVCs), plus the ServiceAccount + module ConfigMap (which the
        provisioner creates outside the Sandbox's ownership → they don't cascade). 404-tolerant
        per object (already-gone is the goal); a non-404 error propagates so the reap retries."""
        core, custom, _ = _apis()
        try:
            custom.delete_namespaced_custom_object(
                SANDBOX_GROUP, SANDBOX_VERSION, self.namespace, SANDBOX_PLURAL, sandbox_name
            )
        except client.ApiException as e:
            _ignore_404(e)
        try:
            core.delete_namespaced_service_account(_sa_name(sandbox_name), self.namespace)
        except client.ApiException as e:
            _ignore_404(e)
        try:
            core.delete_namespaced_config_map(_module_cm_name(sandbox_name), self.namespace)
        except client.ApiException as e:
            _ignore_404(e)

    # --- agent-host autoscaling (the controller IS the autoscaler) ----------
    def get_agent_host_replicas(self) -> int:
        """The agent-host Deployment's DESIRED replica count (spec.replicas)."""
        d = _apps_api().read_namespaced_deployment(AGENT_HOST_DEPLOYMENT, self.namespace)
        return int(d.spec.replicas or 0)

    def set_agent_host_replicas(self, replicas: int) -> None:
        """Scale the agent-host Deployment to `replicas` via the scale subresource (a small,
        conflict-free patch that touches ONLY spec.replicas — not the whole Deployment)."""
        _apps_api().patch_namespaced_deployment_scale(
            AGENT_HOST_DEPLOYMENT, self.namespace, {"spec": {"replicas": replicas}}
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
