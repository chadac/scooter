"""Unit tests for the sandbox k8s CRUD — the 409/404 tolerances + patch-then-flip
fail-safe, mirroring the agent-host provisioner-*.spec.ts. The k8s client is mocked
(monkeypatch `_apis`, like test_modules.py mocks `_api`)."""

from __future__ import annotations

import pytest

import broker.sandbox.k8s as k8s
from broker.sandbox.k8s import SandboxK8s
from broker.sandbox.manifest import DeployConfig


class _ApiExc(Exception):
    def __init__(self, status):
        self.status = status


class _FakeCore:
    def __init__(self, rec):
        self.rec = rec

    def create_namespaced_service_account(self, namespace, body):
        self.rec.append(("sa+", body["metadata"]["name"]))
        if self.rec.sa_conflict:
            raise _ApiExc(409)

    def create_namespaced_config_map(self, namespace, body):
        self.rec.append(("cm+", body["metadata"]["name"]))

    def read_namespaced_config_map(self, name, namespace):
        raise _ApiExc(404)  # no deployment scooterConfigMap by default

    def delete_namespaced_service_account(self, name, namespace):
        self.rec.append(("sa-", name))
        if self.rec.delete_status:
            raise _ApiExc(self.rec.delete_status)

    def delete_namespaced_config_map(self, name, namespace):
        self.rec.append(("cm-", name))
        if self.rec.delete_status:
            raise _ApiExc(self.rec.delete_status)


class _FakeCustom:
    def __init__(self, rec):
        self.rec = rec

    def create_namespaced_custom_object(self, group, version, namespace, plural, body):
        self.rec.append(("sb+", body["metadata"]["name"]))
        if self.rec.sb_conflict:
            raise _ApiExc(409)

    def patch_namespaced_custom_object(self, group, version, namespace, plural, name, body):
        self.rec.append(("patch", name, body["spec"]))

    def delete_namespaced_custom_object(self, group, version, namespace, plural, name):
        self.rec.append(("sb-", name))
        if self.rec.delete_status:
            raise _ApiExc(self.rec.delete_status)

    def get_namespaced_custom_object(self, group, version, namespace, plural, name):
        return {"spec": {"podTemplate": {"spec": {"containers": [{"name": "sandbox", "image": "img"}]}}}}


class _Rec(list):
    sa_conflict = False
    sb_conflict = False
    delete_status = None


@pytest.fixture(autouse=True)
def _mock_apis(monkeypatch):
    rec = _Rec()
    monkeypatch.setattr(k8s.client, "ApiException", _ApiExc, raising=False)
    monkeypatch.setattr(k8s, "_apis", lambda: (_FakeCore(rec), _FakeCustom(rec)))
    return rec


def _sb() -> SandboxK8s:
    return SandboxK8s(DeployConfig(namespace="agent-sandbox", sandbox_image="img"))


def test_create_makes_sa_cm_sandbox(_mock_apis):
    ref = _sb().create("c1", "thread-1", resources=None)
    assert ref.name == "conv-c1"
    ops = [o[0] for o in _mock_apis]
    assert ops == ["sa+", "cm+", "sb+"]


def test_create_tolerates_existing_sa_and_sandbox(_mock_apis):
    _mock_apis.sa_conflict = True
    _mock_apis.sb_conflict = True
    # 409 on SA + Sandbox must NOT raise; the adopted Sandbox is resumed (replicas 1).
    _sb().create("c1", None, resources=None)
    assert any(o[0] == "patch" and o[2] == {"replicas": 1} for o in _mock_apis)


def test_suspend_flips_replicas_0_and_ignores_404(_mock_apis):
    _sb().suspend("c1")
    assert ("patch", "conv-c1", {"replicas": 0}) in _mock_apis
    _mock_apis.delete_status = 404  # not used by suspend, but resume/destroy tolerate

def test_resume_without_size_flips_replicas_only(_mock_apis):
    _sb().resume("c1", resources=None)
    patches = [o for o in _mock_apis if o[0] == "patch"]
    assert patches == [("patch", "conv-c1", {"replicas": 1})]


def test_resume_with_size_patches_resources_then_flips(_mock_apis):
    _sb().resume("c1", resources={"limits": {"memory": "8Gi"}})
    patches = [o for o in _mock_apis if o[0] == "patch"]
    # First patch carries container resources (podTemplate), second flips replicas.
    assert "podTemplate" in patches[0][2]
    assert patches[1][2] == {"replicas": 1}


def test_destroy_deletes_all_three_ignoring_404(_mock_apis):
    _mock_apis.delete_status = 404
    _sb().destroy("c1")  # must not raise
    assert [o[0] for o in _mock_apis] == ["sb-", "sa-", "cm-"]


def test_destroy_propagates_non_404(_mock_apis):
    _mock_apis.delete_status = 500
    with pytest.raises(_ApiExc):
        _sb().destroy("c1")
