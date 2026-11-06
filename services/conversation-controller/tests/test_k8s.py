"""Tier 1: ControllerK8s against a fake apiserver that serves the same API versions a real
cluster does, no cluster.

test_loop.py fakes ControllerK8s wholesale, so it cannot check what a call addresses; the
version-aware fake here 404s an unserved version the way a cluster does, and a 404 reads as
"already gone" to ControllerK8s.
"""

import pytest

from kubernetes import client

import conversation_controller.k8s as k8s_mod
from conversation_controller.k8s import ControllerK8s
from conversation_controller.loop import reconcile_once

from .test_loop import FakeRows, RowStore

NS = "agent-sandbox"

# What a real cluster serves; a request to anything else is a 404.
SERVED = {
    ("agents.x-k8s.io", "v1beta1", "sandboxes"),
}


def _not_found(what: str) -> client.ApiException:
    return client.ApiException(status=404, reason=f"Not Found: {what}")


def _merge(dst: dict, patch: dict) -> None:
    """Recurse into dicts and overwrite leaves."""
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _merge(dst[k], v)
        else:
            dst[k] = v


class FakeCustomObjects:
    """Version-aware CustomObjectsApi over the in-memory Sandboxes."""

    def __init__(self, sandboxes=None):
        self.sandboxes = {cr["metadata"]["name"]: cr for cr in (sandboxes or [])}
        self.requests: list[tuple[str, str, str, str]] = []  # (verb, group, version, plural)

    def _store(self, group, version, plural, verb):
        self.requests.append((verb, group, version, plural))
        if (group, version, plural) not in SERVED:
            raise _not_found(f"{group}/{version} {plural}")
        return self.sandboxes

    def patch_namespaced_custom_object(
        self, group=None, version=None, namespace=None, plural=None, name=None, body=None, **_kw
    ):
        store = self._store(group, version, plural, "patch")
        if name not in store:
            raise _not_found(name)
        _merge(store[name], body)

    def delete_namespaced_custom_object(self, group, version, namespace, plural, name, **_kw):
        store = self._store(group, version, plural, "delete")
        if store.pop(name, None) is None:
            raise _not_found(name)

    def list_namespaced_custom_object(self, group, version, namespace, plural, **_kw):
        store = self._store(group, version, plural, "list")
        return {"items": list(store.values())}


class FakeCore:
    def __init__(self, host_pods=None, sandbox_pods=None):
        self._host_pods = host_pods or []
        self.sandbox_pods = set(sandbox_pods or [])
        self.deleted_pods: list[str] = []
        self.deleted_sas: list[str] = []
        self.deleted_cms: list[str] = []

    def list_namespaced_pod(self, namespace, label_selector=None, **_kw):
        if label_selector == k8s_mod.AGENT_HOST_LABEL:
            return client.V1PodList(items=list(self._host_pods))
        # The controller strips agents.x-k8s.io/* labels, so no selector finds a sandbox pod.
        return client.V1PodList(items=[])

    def delete_namespaced_pod(self, name, namespace, **_kw):
        if name not in self.sandbox_pods:
            raise _not_found(name)
        self.sandbox_pods.discard(name)
        self.deleted_pods.append(name)

    def patch_namespaced_pod(self, name, namespace, body, **_kw):
        return None

    def delete_namespaced_service_account(self, name, namespace, **_kw):
        self.deleted_sas.append(name)

    def delete_namespaced_config_map(self, name, namespace, **_kw):
        self.deleted_cms.append(name)


def _ready_pod(name="agent-host-0", ip="10.0.0.1"):
    return client.V1Pod(
        metadata=client.V1ObjectMeta(name=name, annotations={}),
        status=client.V1PodStatus(
            phase="Running",
            pod_ip=ip,
            conditions=[client.V1PodCondition(type="Ready", status="True")],
        ),
    )


def _sandbox_cr(name, mode="Running", age="2026-10-05T01:00:00Z"):
    return {
        "metadata": {"name": name, "creationTimestamp": age},
        "spec": {"operatingMode": mode},
    }


def _conversation_row(name, sandbox_ref, phase="Suspended", gen=2):
    return {
        "metadata": {"name": name},
        "spec": {"sandboxRef": sandbox_ref},
        "status": {"phase": phase, "generation": gen},
    }


@pytest.fixture
def cluster(monkeypatch):
    """A ControllerK8s wired to the fake apiserver, plus handles on it and on the rows."""
    custom = FakeCustomObjects(sandboxes=[_sandbox_cr("conv-fv25vg")])
    core = FakeCore(host_pods=[_ready_pod()], sandbox_pods=["conv-fv25vg"])
    monkeypatch.setattr(k8s_mod, "_apis", lambda: (core, custom, None))
    rows = FakeRows(RowStore([_conversation_row("fv25vg", "conv-fv25vg")]))
    return ControllerK8s(namespace=NS), core, custom, rows


# --- the suspend patch addresses a served version --------------------------------------

def test_suspend_sandbox_patches_the_api_version_the_cluster_serves(cluster):
    k8s, _core, custom, _rows = cluster
    k8s.suspend_sandbox("conv-fv25vg")
    assert custom.sandboxes["conv-fv25vg"]["spec"]["operatingMode"] == "Suspended", (
        "the suspend never landed — it was addressed to an API version the cluster does not serve"
    )


def test_every_sandbox_call_uses_one_api_version(cluster):
    # Pin the whole Sandbox surface to one version.
    k8s, _core, custom, _rows = cluster
    k8s.suspend_sandbox("conv-fv25vg")
    k8s.list_sandboxes()
    k8s.reclaim_sandbox_pod("conv-fv25vg")
    k8s.delete_sandbox_tree("conv-fv25vg")
    versions = {v for _verb, g, v, p in custom.requests if p == "sandboxes"}
    assert versions == {k8s_mod.SANDBOX_VERSION}, f"mixed Sandbox API versions: {versions}"


# --- the escalation must never destroy the workspace -----------------------------------

def test_a_zombie_is_repaired_by_the_suspend_and_never_escalates(cluster):
    # One suspend lands and the destructive escalation is never reached.
    k8s, core, custom, rows = cluster
    for _ in range(50):
        reconcile_once(k8s, cap=10, rows=rows)
    assert custom.sandboxes["conv-fv25vg"]["spec"]["operatingMode"] == "Suspended"
    assert core.deleted_pods == [], "a sandbox that suspended cleanly needs no pod reclaim"


def test_zombie_escalation_reclaims_the_pod_but_keeps_the_workspace_pvc(cluster):
    # A sandbox that will not stay down gets its pod reclaimed while the Sandbox CR, and so the
    # workspace PVC, survives.
    k8s, core, custom, rows = cluster
    for _ in range(50):
        reconcile_once(k8s, cap=10, rows=rows)
        # The resume race, re-armed each tick only while the Sandbox still exists.
        if "conv-fv25vg" in custom.sandboxes:
            custom.sandboxes["conv-fv25vg"]["spec"] = {"operatingMode": "Running"}

    assert "conv-fv25vg" in custom.sandboxes, (
        "the repair deleted the Sandbox CR — its workspace PVC cascades with it (#709)"
    )
    assert ("delete", "agents.x-k8s.io", "v1beta1", "sandboxes") not in custom.requests
    assert core.deleted_pods == ["conv-fv25vg"], "the leaked pod must still be reclaimed, once"


def test_reclaim_sandbox_pod_is_tolerant_of_an_already_gone_pod(cluster):
    k8s, core, _custom, _rows = cluster
    core.sandbox_pods.clear()
    k8s.reclaim_sandbox_pod("conv-fv25vg")
    assert core.deleted_pods == []


def test_delete_sandbox_tree_removes_the_sa_and_module_configmap(cluster):
    k8s, core, custom, rows = cluster
    k8s.delete_sandbox_tree("conv-fv25vg")
    assert "conv-fv25vg" not in custom.sandboxes
    assert core.deleted_sas == ["sandbox-fv25vg"]
    assert core.deleted_cms == ["conv-fv25vg-module"]


# --- overlay retention: suspend time and PVC deletion ----------------------------------


def test_suspended_seconds_comes_from_the_suspended_condition(monkeypatch):
    sb = _sandbox_cr("conv-old", mode="Suspended")
    sb["status"] = {"conditions": [
        {"type": "Ready", "status": "False", "lastTransitionTime": "2026-01-01T00:00:00Z"},
        {"type": "Suspended", "status": "True", "lastTransitionTime": "2026-10-01T00:00:00Z"},
    ]}
    running = _sandbox_cr("conv-live")
    custom = FakeCustomObjects(sandboxes=[sb, running])
    monkeypatch.setattr(k8s_mod, "_apis", lambda: (FakeCore(), custom, None))
    got = {s.name: s.suspended_seconds for s in ControllerK8s(namespace=NS).list_sandboxes()}
    assert got["conv-live"] is None
    assert got["conv-old"] > 86400  # well over a day before now


def test_delete_pvc_tolerates_one_already_gone(monkeypatch):
    class Core(FakeCore):
        def delete_namespaced_persistent_volume_claim(self, name, namespace, **_kw):
            raise _not_found(name)

    monkeypatch.setattr(k8s_mod, "_apis", lambda: (Core(), FakeCustomObjects(sandboxes=[]), None))
    ControllerK8s(namespace=NS).delete_pvc("scooter-rw-conv-gone")  # must not raise
