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

    # Pod reads back the image-skew cycle: `pods_live` counts how many polls still
    # report the old pod before it goes away (0 = already gone).
    def list_namespaced_pod(self, namespace, label_selector):
        self.rec.append(("pods", label_selector))
        if self.rec.pods_live > 0:
            self.rec.pods_live -= 1
            return _PodList([object()])
        return _PodList([])

    def read_namespaced_pod(self, namespace, name):
        raise _ApiExc(404)


class _PodList:
    def __init__(self, items):
        self.items = items


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
        return {
            "spec": {
                "operatingMode": self.rec.operating_mode,
                "podTemplate": {"spec": {"containers": [{"name": "sandbox", "image": self.rec.image}]}},
            }
        }


class _Rec(list):
    sa_conflict = False
    sb_conflict = False
    delete_status = None
    # What the EXISTING Sandbox CR reports — the knobs the image-skew tests turn.
    image = "img"
    operating_mode = "Running"
    pods_live = 0


@pytest.fixture(autouse=True)
def _mock_apis(monkeypatch):
    rec = _Rec()
    monkeypatch.setattr(k8s.client, "ApiException", _ApiExc, raising=False)
    monkeypatch.setattr(k8s, "_apis", lambda: (_FakeCore(rec), _FakeCustom(rec)))
    return rec


def _sb() -> SandboxK8s:
    return SandboxK8s(DeployConfig(namespace="agent-sandbox", sandbox_image="img"))


def test_create_makes_sa_and_sandbox(_mock_apis):
    # No module CM: create() only makes the SA + Sandbox (modules pull from the broker).
    ref = _sb().create("c1", "thread-1", resources=None)
    assert ref.name == "conv-c1"
    ops = [o[0] for o in _mock_apis]
    assert ops == ["sa+", "sb+"]


def test_create_tolerates_existing_sa_and_sandbox(_mock_apis):
    _mock_apis.sa_conflict = True
    _mock_apis.sb_conflict = True
    # 409 on SA + Sandbox must NOT raise; the adopted Sandbox is resumed (operatingMode).
    _sb().create("c1", None, resources=None)
    assert any(o[0] == "patch" and o[2] == {"operatingMode": "Running"} for o in _mock_apis)


def test_suspend_sets_operating_mode_suspended_and_ignores_404(_mock_apis):
    _sb().suspend("c1")
    assert ("patch", "conv-c1", {"operatingMode": "Suspended"}) in _mock_apis
    _mock_apis.delete_status = 404  # not used by suspend, but resume/destroy tolerate

def test_resume_without_size_sets_running_only(_mock_apis):
    _sb().resume("c1", resources=None)
    patches = [o for o in _mock_apis if o[0] == "patch"]
    assert patches == [("patch", "conv-c1", {"operatingMode": "Running"})]


def test_resume_with_size_patches_resources_then_sets_running(_mock_apis):
    _sb().resume("c1", resources={"limits": {"memory": "8Gi"}})
    patches = [o for o in _mock_apis if o[0] == "patch"]
    # First patch carries container resources (podTemplate), second flips operatingMode.
    assert "podTemplate" in patches[0][2]
    assert patches[1][2] == {"operatingMode": "Running"}


# --- image skew (issue #560) -------------------------------------------------
#
# A Sandbox keeps the image it was born with, so after a platform upgrade a live
# conversation drives an OLD sandbox from a NEW agent-host and every run is dead on
# arrival. Every path to Running must reconcile the image, and ONE cycle must be
# enough to adopt it.


def _image_patches(rec):
    """The container images carried by the patches recorded so far."""
    return [
        c["image"]
        for op in rec
        if op[0] == "patch" and "podTemplate" in op[2]
        for c in op[2]["podTemplate"]["spec"]["containers"]
    ]


def test_resume_patches_a_stale_image_before_running(_mock_apis):
    _mock_apis.image = "old-img"  # born before the upgrade
    _mock_apis.operating_mode = "Suspended"
    _sb().resume("c1", resources=None)
    patches = [o for o in _mock_apis if o[0] == "patch"]
    # The image is reconciled FIRST, then the flip to Running brings the pod up on it —
    # one suspend/resume is enough, with no operator cycling.
    assert _image_patches(_mock_apis) == ["img"]
    assert patches[-1][2] == {"operatingMode": "Running"}


def test_resume_of_a_running_stale_sandbox_cycles_the_pod(_mock_apis):
    _mock_apis.image = "old-img"
    _mock_apis.operating_mode = "Running"  # pod already up on the old image
    _sb().resume("c1", resources=None)
    modes = [o[2]["operatingMode"] for o in _mock_apis if o[0] == "patch" and "operatingMode" in o[2]]
    # Patching the template does not restart a running pod, so the sandbox is dropped
    # and brought back — and the pod's disappearance is WAITED for in between.
    assert modes == ["Suspended", "Running"]
    assert any(o[0] == "pods" for o in _mock_apis)


def test_resume_does_not_touch_a_current_image(_mock_apis):
    _sb().resume("c1", resources=None)  # rec.image == deploy image
    assert _image_patches(_mock_apis) == []
    assert [o[2] for o in _mock_apis if o[0] == "patch"] == [{"operatingMode": "Running"}]


def test_resume_patches_size_and_image_together(_mock_apis):
    _mock_apis.image = "old-img"
    _mock_apis.operating_mode = "Suspended"
    _sb().resume("c1", resources={"limits": {"memory": "8Gi"}})
    container = next(o for o in _mock_apis if o[0] == "patch" and "podTemplate" in o[2])[2]
    patched = container["podTemplate"]["spec"]["containers"][0]
    assert patched["image"] == "img"
    assert patched["resources"] == {"limits": {"memory": "8Gi"}}


def test_adopting_an_existing_sandbox_reconciles_its_image(_mock_apis):
    # The post-upgrade path: the agent-host rolls, re-creates the conversation, and the
    # broker adopts the Sandbox that is already there (409) — on the old image.
    _mock_apis.sb_conflict = True
    _mock_apis.image = "old-img"
    _sb().create("c1", None, resources=None)
    assert _image_patches(_mock_apis) == ["img"]


def test_await_pod_gone_gives_up_at_the_deadline(_mock_apis):
    # A pod that never terminates must not fail the resume — the conversation would go
    # down for a slow delete. It logs and carries on.
    _mock_apis.pods_live = 10_000

    class _Clock:
        def __init__(self):
            self.t = 0.0
            self.slept = 0

        def monotonic(self):
            return self.t

        def sleep(self, s):
            self.slept += 1
            self.t += s

    clock = _Clock()
    _sb()._await_pod_gone("conv-c1", timeout_s=5.0, poll_s=1.0, clock=clock)  # must not raise
    assert clock.slept >= 5


def test_destroy_deletes_sandbox_and_sa_ignoring_404(_mock_apis):
    _mock_apis.delete_status = 404
    _sb().destroy("c1")  # must not raise
    assert [o[0] for o in _mock_apis] == ["sb-", "sa-"]


def test_destroy_propagates_non_404(_mock_apis):
    _mock_apis.delete_status = 500
    with pytest.raises(_ApiExc):
        _sb().destroy("c1")
