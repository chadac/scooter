"""Tier 1 — ControllerK8s against a fake apiserver that serves the SAME API versions a real
cluster does. No cluster.

test_loop.py fakes ControllerK8s wholesale, so the one thing it cannot check is what a call
actually ADDRESSES. That gap is issue #709: the zombie repair's suspend patch went to
agents.x-k8s.io/v1alpha1, which 404s, and a 404 here reads as "already gone" — so the suspend
never landed and the repair escalated to deleting the Sandbox CR, cascading the conversation's
workspace PVC.

The fake apiserver below is version-aware for exactly that reason: an unserved version 404s here
the way it does on a cluster.
"""

import pytest

from kubernetes import client

import conversation_controller.k8s as k8s_mod
from conversation_controller.k8s import ControllerK8s
from conversation_controller.loop import reconcile_once

NS = "agent-sandbox"

# What a real cluster serves. A request to anything else is a 404 — the same answer the
# apiserver gives for an unknown apiVersion, and the whole point of this fake.
SERVED = {
    ("agents.x-k8s.io", "v1beta1", "sandboxes"),
    ("scooter.chadac.dev", "v1alpha1", "conversations"),
}


def _not_found(what: str) -> client.ApiException:
    return client.ApiException(status=404, reason=f"Not Found: {what}")


def _merge(dst: dict, patch: dict) -> None:
    """Strategic-merge-ish: recurse into dicts, overwrite leaves (enough for these specs)."""
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _merge(dst[k], v)
        else:
            dst[k] = v


class FakeCustomObjects:
    """Version-aware CustomObjectsApi over two in-memory collections."""

    def __init__(self, sandboxes=None, conversations=None):
        self.sandboxes = {cr["metadata"]["name"]: cr for cr in (sandboxes or [])}
        self.conversations = {cr["metadata"]["name"]: cr for cr in (conversations or [])}
        self.requests: list[tuple[str, str, str, str]] = []  # (verb, group, version, plural)

    def _store(self, group, version, plural, verb):
        self.requests.append((verb, group, version, plural))
        if (group, version, plural) not in SERVED:
            raise _not_found(f"{group}/{version} {plural}")
        return self.sandboxes if plural == "sandboxes" else self.conversations

    def patch_namespaced_custom_object(
        self, group=None, version=None, namespace=None, plural=None, name=None, body=None, **_kw
    ):
        store = self._store(group, version, plural, "patch")
        if name not in store:
            raise _not_found(name)
        _merge(store[name], body)

    def patch_namespaced_custom_object_status(self, group, version, namespace, plural, name, body, **_kw):
        store = self._store(group, version, plural, "patch-status")
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
        self.sandbox_pods = set(sandbox_pods or [])   # pod names backing Sandboxes
        self.deleted_pods: list[str] = []
        self.deleted_sas: list[str] = []
        self.deleted_cms: list[str] = []

    def list_namespaced_pod(self, namespace, label_selector=None, **_kw):
        if label_selector == k8s_mod.AGENT_HOST_LABEL:
            return client.V1PodList(items=list(self._host_pods))
        # The sandbox-name selector the pod reclaim uses.
        items = [
            client.V1Pod(metadata=client.V1ObjectMeta(name=n), status=client.V1PodStatus())
            for n in sorted(self.sandbox_pods)
            if label_selector == f"{k8s_mod.SANDBOX_NAME_LABEL}={n}"
        ]
        return client.V1PodList(items=items)

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


def _conversation_cr(name, sandbox_ref, phase="Suspended", gen=2):
    return {
        "metadata": {"name": name},
        "spec": {"sandboxRef": sandbox_ref},
        "status": {"phase": phase, "generation": gen},
    }


@pytest.fixture
def cluster(monkeypatch):
    """A ControllerK8s wired to the fake apiserver, plus handles on both stores."""
    custom = FakeCustomObjects(
        sandboxes=[_sandbox_cr("conv-fv25vg")],
        conversations=[_conversation_cr("fv25vg", "conv-fv25vg")],
    )
    core = FakeCore(host_pods=[_ready_pod()], sandbox_pods=["conv-fv25vg"])
    monkeypatch.setattr(k8s_mod, "_apis", lambda: (core, custom, None))
    return ControllerK8s(namespace=NS), core, custom


# --- the cause: the suspend patch went to a version nothing serves ---------------------

def test_suspend_sandbox_patches_the_api_version_the_cluster_serves(cluster):
    # The direct reproduction. Pre-fix this patch went to agents.x-k8s.io/v1alpha1, the fake
    # 404s it exactly as a real apiserver does, ControllerK8s swallows the 404 as "already
    # gone" — and the Sandbox is still Running afterwards.
    k8s, _core, custom = cluster
    k8s.suspend_sandbox("conv-fv25vg")
    assert custom.sandboxes["conv-fv25vg"]["spec"]["operatingMode"] == "Suspended", (
        "the suspend never landed — it was addressed to an API version the cluster does not serve"
    )


def test_every_sandbox_call_uses_one_api_version(cluster):
    # The drift that caused #709 was ONE call site left behind by the v1beta1 migration. Pin
    # the whole surface, not just the one that broke.
    k8s, _core, custom = cluster
    k8s.suspend_sandbox("conv-fv25vg")
    k8s.list_sandboxes()
    k8s.reclaim_sandbox_pod("conv-fv25vg")
    k8s.delete_sandbox_tree("conv-fv25vg")
    versions = {v for _verb, g, v, p in custom.requests if p == "sandboxes"}
    assert versions == {k8s_mod.SANDBOX_VERSION}, f"mixed Sandbox API versions: {versions}"


# --- the blast radius: the escalation must never destroy the workspace -----------------

def test_a_zombie_is_repaired_by_the_suspend_and_never_escalates(cluster):
    # The whole loop over the fake apiserver. Against a cluster that serves v1beta1 the repair
    # does what it was designed to do: ONE suspend lands, the zombie is gone, and the terminal
    # escalation — the destructive path — is never reached. Pre-fix this ended with the Sandbox
    # CR deleted and the workspace with it (#709).
    k8s, core, custom = cluster
    for _ in range(50):
        reconcile_once(k8s, cap=10)
    assert custom.sandboxes["conv-fv25vg"]["spec"]["operatingMode"] == "Suspended"
    assert core.deleted_pods == [], "a sandbox that suspended cleanly needs no pod reclaim"


def test_zombie_escalation_reclaims_the_pod_but_keeps_the_workspace_pvc(cluster):
    # The escalation still has to happen for a sandbox that genuinely will not stay down (an
    # upstream resume race flips it back Running every tick). It must reclaim the leaked POD and
    # leave the Sandbox CR alone: deleting the CR cascades its volumeClaimTemplate PVCs, which is
    # how a live conversation's /workspace came back empty (#709).
    k8s, core, custom = cluster
    for _ in range(50):
        reconcile_once(k8s, cap=10)
        custom.sandboxes.setdefault("conv-fv25vg", {})  # (never recreated — see the assert below)
        custom.sandboxes["conv-fv25vg"]["spec"] = {"operatingMode": "Running"}  # the resume race

    assert "conv-fv25vg" in custom.sandboxes, (
        "the repair deleted the Sandbox CR — its workspace PVC cascades with it (#709)"
    )
    assert ("delete", "agents.x-k8s.io", "v1beta1", "sandboxes") not in custom.requests
    assert core.deleted_pods == ["conv-fv25vg"], "the leaked pod must still be reclaimed, once"


def test_reclaim_sandbox_pod_is_tolerant_of_an_already_gone_pod(cluster):
    # The pod may have exited between the list and the delete; that is the reclaim's goal, not
    # an error. (A non-404 still propagates so the loop retries — see _ignore_404.)
    k8s, core, _custom = cluster
    core.sandbox_pods.clear()
    k8s.reclaim_sandbox_pod("conv-fv25vg")
    assert core.deleted_pods == []


def test_delete_sandbox_tree_removes_the_sa_and_module_configmap(cluster):
    # The reaper path (an orphan with no owning Conversation) still deletes everything: the
    # Sandbox CR cascades pod + PVCs, the SA and module CM do not and are deleted directly.
    k8s, core, custom = cluster
    k8s.delete_sandbox_tree("conv-fv25vg")
    assert "conv-fv25vg" not in custom.sandboxes
    assert core.deleted_sas == ["sandbox-fv25vg"]
    assert core.deleted_cms == ["conv-fv25vg-module"]
