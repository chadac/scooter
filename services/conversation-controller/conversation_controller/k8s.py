"""Thin k8s access for the controller: agent-host pods, Sandboxes and the agent-host Deployment."""

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
    """Swallow a 404 (the object is already gone) and re-raise anything else so the caller retries."""
    if e.status != 404:
        raise e

AGENT_HOST_LABEL = "app=agent-host"
DELETION_COST_ANNOTATION = "controller.kubernetes.io/pod-deletion-cost"
AGENT_HOST_DEPLOYMENT = "agent-host"  # the Deployment the controller autoscales

# The upstream agent-sandbox Sandbox CR; every Sandbox call addresses it through these, since an
# unserved group/version 404s silently.
SANDBOX_GROUP = "agents.x-k8s.io"
SANDBOX_VERSION = "v1beta1"
SANDBOX_PLURAL = "sandboxes"

# Per-conversation object names derived from the Sandbox name, matching saName/moduleCmName in
# k8sProvisioner.ts.
def _sa_name(sandbox_name: str) -> str:
    return "sandbox-" + sandbox_name.removeprefix("conv-")


def _module_cm_name(sandbox_name: str) -> str:
    return sandbox_name + "-module"

# The env is not named AGENT_HOST_PORT because Kubernetes injects a service-link env of that name.
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
    """Imperative k8s ops the reconcile loop uses, all targeting the controller's own namespace."""

    namespace: str

    # --- agent-host pods (assignment targets) ------------------------------
    def list_host_pods(self) -> list[Pod]:
        """Name, readiness, IP, deletion cost and terminating flag of every agent-host pod."""
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
        """Annotate an agent-host pod with its scale-down deletion cost, tolerating a 404."""
        core, _, _ = _apis()
        body = {"metadata": {"annotations": {DELETION_COST_ANNOTATION: str(cost)}}}
        try:
            core.patch_namespaced_pod(name, self.namespace, body)
        except client.ApiException as e:
            _ignore_404(e)

    # --- revive-push (seamless rollout) ------------------------------------
    def notify_revive(self, host_ip: str, conv_name: str, generation: int) -> None:
        """POST a fire-and-forget revive for `conv_name` to the newly assigned host from a daemon thread, so an unroutable pod IP can never block the reconcile loop."""
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
                logger.warning(
                    "revive-push failed",
                    extra={
                        **_C,
                        "conversation_id": conv_name,
                        "url": url,
                        "generation": generation,
                        "fallback": "lazy-revive",
                        "error": format_error(e),
                    },
                )

        threading.Thread(target=_push, name=f"revive-{conv_name}", daemon=True).start()

    # --- orphaned-Sandbox reaper -------------------------------------------
    def suspend_sandbox(self, name: str) -> None:
        """Merge-patch the Sandbox's spec.operatingMode to Suspended, tolerating a 404."""
        _, custom, _ = _apis()
        try:
            custom.patch_namespaced_custom_object(
                group=SANDBOX_GROUP, version=SANDBOX_VERSION, plural=SANDBOX_PLURAL,
                namespace=self.namespace, name=name,
                body={"spec": {"operatingMode": "Suspended"}},
            )
        except client.ApiException as e:
            _ignore_404(e)

    def reclaim_sandbox_pod(self, name: str) -> None:
        """Suspend the Sandbox and delete its leaked pod, never the Sandbox CR itself (that would cascade the workspace PVC)."""
        core, _, _ = _apis()
        self.suspend_sandbox(name)
        # The pod is named after its Sandbox; the controller strips our label.
        try:
            core.delete_namespaced_pod(name, self.namespace)
        except client.ApiException as e:
            _ignore_404(e)

    def list_sandboxes(self) -> list["SandboxRef"]:
        """Every per-conversation Sandbox as a SandboxRef."""
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
            suspended = None
            for c in (cr.get("status") or {}).get("conditions") or []:
                if c.get("type") == "Suspended" and c.get("status") == "True" and c.get("lastTransitionTime"):
                    suspended = (now - _parse_ts(c["lastTransitionTime"])).total_seconds()
            out.append(SandboxRef(name=name, age_seconds=age, operating_mode=mode, suspended_seconds=suspended))
        return out

    def list_pvc_names(self) -> set[str]:
        core, _, _ = _apis()
        return {p.metadata.name for p in core.list_namespaced_persistent_volume_claim(self.namespace).items}

    def delete_pvc(self, name: str) -> None:
        """Delete a PVC, tolerating one already gone."""
        core, _, _ = _apis()
        try:
            core.delete_namespaced_persistent_volume_claim(name, self.namespace)
        except client.ApiException as e:
            _ignore_404(e)

    def delete_sandbox_tree(self, sandbox_name: str) -> None:
        """Delete an orphaned Sandbox plus its ServiceAccount and module ConfigMap (which do not cascade), tolerating a 404 per object."""
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

    # --- agent-host autoscaling --------------------------------------------
    def get_agent_host_replicas(self) -> int:
        """The agent-host Deployment's spec.replicas."""
        d = _apps_api().read_namespaced_deployment(AGENT_HOST_DEPLOYMENT, self.namespace)
        return int(d.spec.replicas or 0)

    def set_agent_host_replicas(self, replicas: int) -> None:
        """Scale the agent-host Deployment to `replicas` via the scale subresource."""

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
