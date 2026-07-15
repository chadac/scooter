"""Unit tests for the sandbox lifecycle HTTP API — the two-tier auth gate
(control-SA for lifecycle; control-SA OR owning-sandbox for size) + ref shape.
k8s + store are mocked; auth is overridden with injected identities."""

from __future__ import annotations

import os

os.environ["SANDBOX_LIFECYCLE_ENABLED"] = "true"
os.environ["SANDBOX_CONTROL_SERVICE_ACCOUNTS"] = "system:serviceaccount:agent-manager:agent-host"

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from broker.core.auth import authenticate  # noqa: E402
from broker.core.types import Identity  # noqa: E402
from broker.sandbox.k8s import PodRef  # noqa: E402
from broker.sandbox.resources import SandboxResources  # noqa: E402
from broker.sandbox.routes import create_sandbox_router  # noqa: E402


CONTROL_SA = "system:serviceaccount:agent-manager:agent-host"


def _control() -> Identity:
    return Identity(conversation_id="", namespace="agent-sandbox", service_account=CONTROL_SA, is_approver=False)


def _sandbox(conv: str) -> Identity:
    return Identity(conversation_id=conv, namespace="agent-sandbox",
                    service_account=f"system:serviceaccount:agent-sandbox:sandbox-{conv}")


class _FakeK8s:
    def create(self, conv, thread_id, resources):
        self.created = (conv, thread_id, resources)
        return PodRef(name=f"conv-{conv}", namespace="agent-sandbox")

    def ready_pod(self, name, **kw):
        return PodRef(name=name, namespace="agent-sandbox", pod_ip="10.0.0.5", running=True)

    def suspend(self, conv):
        self.suspended = conv

    def resume(self, conv, resources):
        self.resumed = (conv, resources)
        return PodRef(name=f"conv-{conv}", namespace="agent-sandbox")

    def destroy(self, conv):
        self.destroyed = conv

    def list_sandboxes(self):
        return [PodRef(name="conv-a", namespace="agent-sandbox", running=True)]


class _FakeStore:
    def __init__(self):
        self.sizes = {}

    async def get(self, conv):
        return self.sizes.get(conv)

    async def set(self, conv, spec, now_iso=""):
        self.sizes[conv] = spec

    async def init(self):
        pass


def _client(identity: Identity, k8s=None, store=None):
    k8s = k8s or _FakeK8s()
    store = store or _FakeStore()
    app = FastAPI()
    app.include_router(create_sandbox_router(k8s, store))
    app.dependency_overrides[authenticate] = lambda: identity
    return TestClient(app), k8s, store


# --- lifecycle: control-SA only ---------------------------------------------


def test_ensure_returns_pod_ref_for_control(monkeypatch):
    client, k8s, _ = _client(_control())
    resp = client.post("/sandbox/c1/ensure", json={"threadId": "t1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"name": "conv-c1", "namespace": "agent-sandbox", "podIP": "10.0.0.5", "running": True}
    assert k8s.created[0] == "c1" and k8s.created[1] == "t1"


def test_ensure_forbidden_for_sandbox_sa():
    client, _, _ = _client(_sandbox("c1"))
    assert client.post("/sandbox/c1/ensure", json={}).status_code == 403


def test_suspend_resume_end_list_require_control():
    client, _, _ = _client(_sandbox("c1"))
    assert client.post("/sandbox/c1/suspend").status_code == 403
    assert client.post("/sandbox/c1/resume").status_code == 403
    assert client.post("/sandbox/c1/end").status_code == 403
    assert client.get("/sandbox").status_code == 403


def test_end_destroys_for_control():
    client, k8s, _ = _client(_control())
    assert client.post("/sandbox/c1/end").status_code == 200
    assert k8s.destroyed == "c1"


# --- size: control OR owning sandbox ----------------------------------------


def test_owning_sandbox_can_set_its_own_size():
    client, _, store = _client(_sandbox("c1"))
    resp = client.put("/sandbox/c1/size", json={"limits": {"memory": "8Gi"}})
    assert resp.status_code == 200
    assert store.sizes["c1"].to_dict() == {"limits": {"memory": "8Gi"}}


def test_sandbox_cannot_set_another_convs_size():
    client, _, _ = _client(_sandbox("c1"))
    assert client.put("/sandbox/OTHER/size", json={"limits": {"memory": "8Gi"}}).status_code == 403


def test_control_can_set_any_convs_size():
    client, _, store = _client(_control())
    assert client.put("/sandbox/anyconv/size", json={"requests": {"cpu": "2"}}).status_code == 200
    assert "anyconv" in store.sizes


def test_put_size_rejects_bad_quantity():
    client, _, _ = _client(_control())
    assert client.put("/sandbox/c1/size", json={"limits": {"memory": "8gb"}}).status_code == 400


def test_get_size_returns_none_when_unset():
    client, _, _ = _client(_control())
    assert client.get("/sandbox/c1/size").json() == {"size": None}


def test_ensure_applies_the_stored_size():
    store = _FakeStore()
    store.sizes["c1"] = SandboxResources(limits={"memory": "16Gi"})  # pre-seed the fake
    client, k8s, _ = _client(_control(), store=store)
    client.post("/sandbox/c1/ensure", json={})
    # create() got the rendered size block, not None.
    assert k8s.created[2] == {"limits": {"memory": "16Gi"}}
