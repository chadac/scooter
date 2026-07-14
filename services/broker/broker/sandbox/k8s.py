"""Sandbox k8s CRUD — a faithful Python port of the imperative half of the
agent-host's k8sProvisioner.ts. The broker now owns provisioning: it creates the
per-conversation ServiceAccount + module ConfigMap + Sandbox CR, suspends/resumes
via replicas, destroys, lists (reconcile), ready-polls the pod, and writes/mounts
the module CM.

k8s clients are built lazily via `_apis()` (monkeypatched in tests, like
core/modules.py). The delete/create 404/409 tolerances mirror the TS exactly (a
404 on delete is the goal; a non-404 propagates so we never silently leak a
Sandbox/SA/PVC — findings #7/#8).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from kubernetes import client, config

from .manifest import GROUP, PLURAL_SANDBOXES, VERSION, DeployConfig, sandbox_manifest

logger = logging.getLogger(__name__)

SANDBOX_LABEL = "agents.x-k8s.io/sandbox-name"

_core: client.CoreV1Api | None = None
_custom: client.CustomObjectsApi | None = None


def _apis() -> tuple[client.CoreV1Api, client.CustomObjectsApi]:
    global _core, _custom
    if _core is None or _custom is None:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        _core = client.CoreV1Api()
        _custom = client.CustomObjectsApi()
    return _core, _custom


@dataclass
class PodRef:
    name: str
    namespace: str
    pod_ip: str | None = None
    running: bool = False


def _sandbox_name(cid: str) -> str:
    return f"conv-{cid}"


def _sa_name(cid: str) -> str:
    return f"sandbox-{cid}"


def _ignore(status: int, e: client.ApiException, ok: int) -> None:
    """Swallow ApiException with `ok` status; re-raise anything else."""
    if status != ok:
        raise e


class SandboxK8s:
    """Imperative Sandbox/SA/CM lifecycle over the k8s API."""

    def __init__(self, deploy: DeployConfig) -> None:
        self.deploy = deploy
        self.ns = deploy.namespace

    # --- create (SA + Sandbox), 409-tolerant, adopt-and-resume ---
    # No module ConfigMap: the pod pulls its module config as a tarball from the
    # broker (a root sandbox-os Nix module), so create() only makes the SA + Sandbox.
    def create(self, cid: str, thread_id: str | None, resources: dict | None) -> PodRef:
        _, custom = _apis()
        core, _ = _apis()
        name = _sandbox_name(cid)

        # 1. ServiceAccount (broker identity), tolerate a leftover 409.
        try:
            core.create_namespaced_service_account(
                namespace=self.ns, body={"metadata": {"name": _sa_name(cid), "namespace": self.ns}}
            )
        except client.ApiException as e:
            _ignore(e.status, e, 409)

        # 2. the cold Sandbox. 409 -> adopt the existing one + ensure running.
        already = False
        body = sandbox_manifest(
            conversation_id=cid,
            name=name,
            service_account=_sa_name(cid),
            deploy=self.deploy,
            resources=resources,
            url_thread=thread_id or cid,
        )
        try:
            custom.create_namespaced_custom_object(
                group=GROUP, version=VERSION, namespace=self.ns, plural=PLURAL_SANDBOXES, body=body
            )
        except client.ApiException as e:
            if e.status != 409:
                raise
            already = True

        if already:
            try:
                self._set_replicas(name, 1)
            except client.ApiException as e:
                logger.warning("adopted existing Sandbox %s but resume failed: %s", name, e)

        return PodRef(name=name, namespace=self.ns)

    # --- replicas flip (merge-patch) ---
    def _set_replicas(self, name: str, replicas: int) -> None:
        _, custom = _apis()
        custom.patch_namespaced_custom_object(
            group=GROUP, version=VERSION, namespace=self.ns, plural=PLURAL_SANDBOXES,
            name=name, body={"spec": {"replicas": replicas}},
        )

    def suspend(self, cid: str) -> None:
        try:
            self._set_replicas(_sandbox_name(cid), 0)
        except client.ApiException as e:
            _ignore(e.status, e, 404)  # already gone == already suspended

    def resume(self, cid: str, resources: dict | None) -> PodRef:
        name = _sandbox_name(cid)
        if resources:
            # Patch container resources FIRST (fail-safe: if this throws, we do NOT
            # flip replicas up into a half-patched state).
            self._patch_resources(name, resources)
        self._set_replicas(name, 1)
        return PodRef(name=name, namespace=self.ns)

    def _patch_resources(self, name: str, resources: dict) -> None:
        _, custom = _apis()
        sb = custom.get_namespaced_custom_object(
            group=GROUP, version=VERSION, namespace=self.ns, plural=PLURAL_SANDBOXES, name=name
        )
        containers = (((sb.get("spec") or {}).get("podTemplate") or {}).get("spec") or {}).get("containers") or []
        if not containers:
            raise RuntimeError(f"Sandbox {name} has no container to resize")
        patched = {**containers[0], "resources": resources}
        custom.patch_namespaced_custom_object(
            group=GROUP, version=VERSION, namespace=self.ns, plural=PLURAL_SANDBOXES, name=name,
            body={"spec": {"podTemplate": {"spec": {"containers": [patched, *containers[1:]]}}}},
        )

    # --- destroy (Sandbox + SA), 404-tolerant, non-404 propagates ---
    def destroy(self, cid: str) -> None:
        core, custom = _apis()
        try:
            custom.delete_namespaced_custom_object(
                group=GROUP, version=VERSION, namespace=self.ns, plural=PLURAL_SANDBOXES, name=_sandbox_name(cid)
            )
        except client.ApiException as e:
            _ignore(e.status, e, 404)
        try:
            core.delete_namespaced_service_account(name=_sa_name(cid), namespace=self.ns)
        except client.ApiException as e:
            _ignore(e.status, e, 404)

    # --- reconcile: list per-conversation Sandboxes + running state ---
    def list_sandboxes(self) -> list[PodRef]:
        _, custom = _apis()
        lst = custom.list_namespaced_custom_object(
            group=GROUP, version=VERSION, namespace=self.ns, plural=PLURAL_SANDBOXES
        )
        out: list[PodRef] = []
        for item in lst.get("items", []):
            name = (item.get("metadata") or {}).get("name")
            if not name or not name.startswith("conv-"):
                continue
            replicas = (item.get("spec") or {}).get("replicas", 0)
            out.append(PodRef(name=name, namespace=self.ns, running=replicas > 0))
        return out

    # --- ready-pod resolution (port of resolveReadyPod) ---
    def ready_pod(self, name: str, timeout_s: float = 90.0, poll_s: float = 1.5, clock=time) -> PodRef:
        core, _ = _apis()
        deadline = clock.monotonic() + timeout_s
        last_running = None
        while True:
            pods = core.list_namespaced_pod(namespace=self.ns, label_selector=f"{SANDBOX_LABEL}={name}").items
            if not pods:
                try:
                    p = core.read_namespaced_pod(namespace=self.ns, name=name)
                    pods = [p] if p else []
                except client.ApiException:
                    pods = []
            ready = next(
                (p for p in pods
                 if (p.status.phase == "Running")
                 and all(c.ready for c in (p.status.container_statuses or []))),
                None,
            )
            if ready and ready.metadata.name:
                return PodRef(name=ready.metadata.name, namespace=self.ns, pod_ip=ready.status.pod_ip, running=True)
            last_running = next((p for p in pods if p.status.phase == "Running"), last_running)
            if clock.monotonic() > deadline:
                if last_running:
                    return PodRef(name=last_running.metadata.name, namespace=self.ns,
                                  pod_ip=last_running.status.pod_ip, running=True)
                raise RuntimeError(f"no ready pod for sandbox {self.ns}/{name}")
            clock.sleep(poll_s)
