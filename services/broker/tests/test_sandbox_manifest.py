"""Unit tests for the sandbox manifest builder + resources render/validate.

Mirrors the agent-host's provisioner-*.spec.ts assertions (the manifest is
load-bearing — a wrong port silently breaks every pod). Keep in lockstep with
session/k8sProvisioner.ts `sandboxManifest` until that file is deleted (PR1 St6).
"""

from __future__ import annotations

import pytest

from broker.sandbox.manifest import DeployConfig, sandbox_manifest
from broker.sandbox.resources import (
    GPU_RESOURCE,
    InvalidResource,
    SandboxResources,
    render_resources,
    resolve_resources,
    validate_resources,
)


def _deploy(**over) -> DeployConfig:
    base = dict(namespace="agent-sandbox", sandbox_image="img:latest")
    base.update(over)
    return DeployConfig(**base)


def _container(m: dict) -> dict:
    return m["spec"]["podTemplate"]["spec"]["containers"][0]


def _vols(m: dict) -> list:
    return m["spec"]["podTemplate"]["spec"]["volumes"]


def _mount_names(m: dict) -> set:
    return {vm["name"] for vm in _container(m)["volumeMounts"]}


# --- manifest shape ---------------------------------------------------------


def test_minimal_manifest_has_workspace_and_broker_token():
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sandbox-c1", deploy=_deploy())
    assert m["kind"] == "Sandbox"
    assert m["apiVersion"] == "agents.x-k8s.io/v1beta1"
    assert m["metadata"]["name"] == "conv-c1"
    assert m["spec"]["operatingMode"] == "Running"
    assert m["spec"]["podTemplate"]["spec"]["serviceAccountName"] == "sandbox-c1"
    assert m["spec"]["podTemplate"]["spec"]["automountServiceAccountToken"] is False
    assert "workspace" in _mount_names(m)
    assert "broker-token" in _mount_names(m)
    # workspace PVC always present.
    assert any(v["metadata"]["name"] == "workspace" for v in m["spec"]["volumeClaimTemplates"])


def test_systemd_image_is_unprivileged_with_sys_admin_and_tmpfs():
    """The systemd sandbox must NOT be privileged: that forces the HOST cgroup
    namespace and lets its PID 1 churn the host /kubepods.slice tree (node
    instability / host-session logout). It gets CAP_SYS_ADMIN instead, for the
    stage-2 `specialfs` mounts. See PR #255."""
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa", deploy=_deploy(systemd_image=True))
    assert _container(m)["securityContext"] == {"capabilities": {"add": ["SYS_ADMIN"]}}
    assert "privileged" not in _container(m)["securityContext"]
    assert "run" in _mount_names(m) and "tmp" in _mount_names(m)
    vol_names = {v["name"] for v in _vols(m)}
    assert {"run", "tmp"} <= vol_names


def test_runtime_class_only_on_the_systemd_image():
    """The other half of PR #255: a cgroup-delegating runtime gives PID 1 a writable
    subtree in the pod's OWN cgroup namespace. Only for the systemd image."""
    pod = lambda m: m["spec"]["podTemplate"]["spec"]  # noqa: E731
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa",
                         deploy=_deploy(systemd_image=True, runtime_class="crun"))
    assert pod(m)["runtimeClassName"] == "crun"
    # Unset -> the key is absent entirely (the cluster default runtime), not null.
    assert "runtimeClassName" not in pod(sandbox_manifest(
        conversation_id="c1", name="conv-c1", service_account="sa", deploy=_deploy(systemd_image=True)))
    assert "runtimeClassName" not in pod(sandbox_manifest(
        conversation_id="c1", name="conv-c1", service_account="sa",
        deploy=_deploy(systemd_image=False, runtime_class="crun")))


def test_pull_policy_is_configurable():
    """A side-loaded cluster (kind/k3s/k3d) has no registry behind the image, so
    "Always" is an ImagePullBackOff on every sandbox."""
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa", deploy=_deploy())
    assert _container(m)["imagePullPolicy"] == "Always"  # registry-backed default
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa",
                         deploy=_deploy(pull_policy="IfNotPresent"))
    assert _container(m)["imagePullPolicy"] == "IfNotPresent"


def test_scooter_configmap_mounts_the_deployment_flake():
    """programs.injectedTools / programs.scooterModule default to this path; an
    unmounted CM means a deployment's injected tools silently stop building."""
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa", deploy=_deploy())
    assert "scooter-tools" not in _mount_names(m)
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa",
                         deploy=_deploy(scooter_configmap="my-scooter"))
    mount = next(vm for vm in _container(m)["volumeMounts"] if vm["name"] == "scooter-tools")
    assert mount["mountPath"] == "/etc/agent-sandbox/scooter"
    assert mount["readOnly"] is True
    assert {"name": "scooter-tools", "configMap": {"name": "my-scooter"}} in _vols(m)


def test_non_systemd_is_unprivileged_no_tmpfs():
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa", deploy=_deploy(systemd_image=False))
    assert "securityContext" not in _container(m)
    assert "run" not in _mount_names(m)


def test_aws_accounts_configmap_toggles_mount_and_env():
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa",
                         deploy=_deploy(aws_accounts_configmap="aws-cm"))
    assert "aws-accounts" in _mount_names(m)
    env = {e["name"]: e["value"] for e in _container(m)["env"]}
    assert env["AWS_ACCOUNTS_FILE"] == "/etc/agent-sandbox/aws/accounts.json"


def test_overlay_store_adds_upper_pvc_and_mount():
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa", deploy=_deploy(overlay_store=True))
    assert "scooter-rw" in _mount_names(m)
    assert any(v["metadata"]["name"] == "scooter-rw" for v in m["spec"]["volumeClaimTemplates"])


def test_no_module_configmap_mount():
    # Modules come from the broker tarball, not a CM — the manifest never mounts a
    # per-conversation module CM or a deployment .scooter CM.
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa", deploy=_deploy())
    names = _mount_names(m)
    assert "scooter-conv" not in names
    assert "scooter-tools" not in names


def test_extra_token_audiences_project_tokens():
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa",
                         deploy=_deploy(extra_token_audiences=["svc-a", "svc-b"]))
    assert {"tok-svc-a", "tok-svc-b"} <= _mount_names(m)


def test_public_url_builds_conversation_url_from_threadid():
    m = sandbox_manifest(conversation_id="short", name="conv-short", service_account="sa",
                         deploy=_deploy(public_url="https://scooter.example.com/"), url_thread="full-thread-id")
    env = {e["name"]: e["value"] for e in _container(m)["env"]}
    assert env["CONVERSATION_URL"] == "https://scooter.example.com/?thread=full-thread-id"
    assert env["CONVERSATION_ID"] == "full-thread-id"  # the FULL threadId, not the short name


def test_resources_block_spread_verbatim():
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa", deploy=_deploy(),
                         resources={"requests": {"cpu": "2"}, "limits": {"memory": "8Gi"}})
    assert _container(m)["resources"] == {"requests": {"cpu": "2"}, "limits": {"memory": "8Gi"}}


def test_no_resources_omits_the_block():
    m = sandbox_manifest(conversation_id="c1", name="conv-c1", service_account="sa", deploy=_deploy())
    assert "resources" not in _container(m)


# --- resources render / validate / resolve ---------------------------------


def test_render_passes_cpu_memory_through():
    assert render_resources(SandboxResources(requests={"cpu": "500m", "memory": "1Gi"}, limits={"memory": "4Gi"})) == {
        "requests": {"cpu": "500m", "memory": "1Gi"},
        "limits": {"memory": "4Gi"},
    }


def test_render_gpu_on_both_sides():
    out = render_resources(SandboxResources(requests={"gpu": 2}))
    assert out["requests"][GPU_RESOURCE] == "2"
    assert out["limits"][GPU_RESOURCE] == "2"


def test_render_empty_omits_sides():
    assert render_resources(SandboxResources()) == {}


@pytest.mark.parametrize("bad,field", [
    ({"requests": {"cpu": "half"}}, "requests.cpu"),
    ({"limits": {"memory": "8gb"}}, "limits.memory"),
    ({"requests": {"gpu": -1}}, "requests.gpu"),
])
def test_validate_rejects_bad_quantities(bad, field):
    with pytest.raises(InvalidResource) as ei:
        validate_resources(SandboxResources.from_dict(bad))
    assert ei.value.field == field


def test_resolve_order():
    conv = SandboxResources(requests={"cpu": "4"})
    dep = SandboxResources(requests={"cpu": "1"})
    assert resolve_resources(conv, dep) is conv
    assert resolve_resources(None, dep) is dep
    # Platform default is Guaranteed QoS: requests == limits on cpu AND memory.
    assert resolve_resources(None, None).to_dict() == {
        "requests": {"cpu": "2", "memory": "4Gi"},
        "limits": {"cpu": "2", "memory": "4Gi"},
    }
