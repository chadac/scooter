"""The Sandbox CR manifest builder — a faithful Python port of the agent-host's
`sandboxManifest` (session/k8sProvisioner.ts). The broker now owns provisioning, so
this renders the per-conversation Sandbox (SA + workspace PVC + broker token +
optional overlay/aws/module/config mounts) that agent-sandbox reconciles.

Keep this in lockstep with the TS reference until that file is deleted (PR1 St6):
test_sandbox_manifest.py mirrors the TS provisioner specs' assertions.
"""

from __future__ import annotations

from dataclasses import dataclass, field

GROUP = "agents.x-k8s.io"
# agent-sandbox v0.5.x serves v1beta1 (v1alpha1 deprecated in v0.5.0). Suspend/resume
# is spec.operatingMode ("Running"/"Suspended"), not the old spec.replicas 0/1.
VERSION = "v1beta1"
PLURAL_SANDBOXES = "sandboxes"
SANDBOX_NAME_LABEL = "agents.x-k8s.io/sandbox-name"
CONFIG_FILES_MOUNT_PATH = "/etc/agent-sandbox/config"
SCOOTER_DIR_MOUNT_PATH = "/etc/agent-sandbox/scooter"


@dataclass
class DeployConfig:
    """Deployment-supplied provisioning config (was K8sProvisionerOptions on the
    agent-host; now broker-owned via env — see config.py)."""

    namespace: str
    sandbox_image: str
    # imagePullPolicy for the sandbox container. "Always" picks up a re-pushed :latest
    # on a registry-backed cluster; a SIDE-LOADED cluster (kind/k3s/k3d) has no registry
    # to pull from and must use IfNotPresent/Never or every sandbox ImagePullBackOffs.
    pull_policy: str = "Always"
    # Cgroup-delegating RuntimeClass (e.g. crun) for the systemd sandbox — see the
    # securityContext note in sandbox_manifest(). None = the cluster default runtime.
    runtime_class: str | None = None
    workspace_storage: str = "10Gi"
    broker_audience: str = "agent-broker"
    overlay_store: bool = False
    overlay_storage: str = "20Gi"
    systemd_image: bool = True
    aws_accounts_configmap: str | None = None
    config_files_configmap: str | None = None
    # A deployment's .scooter ConfigMap (its own flake + module.nix), mounted at
    # SCOOTER_DIR_MOUNT_PATH. programs.injectedTools and programs.scooterModule in the
    # sandbox image default to that path, so an unmounted CM means a deployment's
    # injected tools silently stop building.
    scooter_configmap: str | None = None
    extra_token_audiences: list[str] = field(default_factory=list)
    extra_env: list[dict] = field(default_factory=list)  # [{name, value}]
    public_url: str | None = None
    # Name of the ConfigMap holding a consumer manifest overlay (patch applied on top
    # of the generated Sandbox — see overlay.py). None -> no overlay. The PAYLOAD is
    # read lazily by the broker at create time (not baked into DeployConfig) so a
    # ConfigMap edit takes effect on the next conversation without a broker restart.
    manifest_overlay_configmap: str | None = None


def sandbox_manifest(
    *,
    conversation_id: str,
    name: str,
    service_account: str,
    deploy: DeployConfig,
    resources: dict | None = None,  # already-rendered k8s resources block
    url_thread: str | None = None,  # full threadId for CONVERSATION_URL deep-link
    overlay: dict | None = None,  # parsed consumer overlay (see overlay.apply_overlay)
) -> dict:
    # NOTE: NO per-conversation module ConfigMap. The pod pulls its module config
    # (deployment defaults + registry modules) as a tarball from the broker (a root
    # sandbox-os Nix module fetchTarballs it into /etc/scooter/modules on the workspace
    # PVC). The DEPLOYMENT's .scooter CM is a different thing and IS mounted below.
    ns = deploy.namespace
    image = deploy.sandbox_image
    audience = deploy.broker_audience
    systemd = deploy.systemd_image
    overlay_store = deploy.overlay_store  # the .scooter-rw PVC flag (NOT the manifest overlay)
    config_files = deploy.config_files_configmap
    scooter_cm = deploy.scooter_configmap
    aws_cm = deploy.aws_accounts_configmap
    extra_auds = deploy.extra_token_audiences or []
    extra_env = deploy.extra_env or []
    thread = url_thread or conversation_id

    # --- container volumeMounts ---
    volume_mounts: list[dict] = [
        {"name": "workspace", "mountPath": "/workspace"},
        {"name": "broker-token", "mountPath": "/var/run/secrets/broker", "readOnly": True},
    ]
    if aws_cm:
        volume_mounts.append({"name": "aws-accounts", "mountPath": "/etc/agent-sandbox/aws", "readOnly": True})
    if systemd:
        volume_mounts += [{"name": "run", "mountPath": "/run"}, {"name": "tmp", "mountPath": "/tmp"}]
    if scooter_cm:
        volume_mounts.append({"name": "scooter-tools", "mountPath": SCOOTER_DIR_MOUNT_PATH, "readOnly": True})
    for aud in extra_auds:
        volume_mounts.append({"name": f"tok-{aud}", "mountPath": f"/var/run/secrets/{aud}", "readOnly": True})
    if overlay_store:
        volume_mounts.append({"name": "scooter-rw", "mountPath": "/nix/.scooter-rw"})
    if config_files:
        volume_mounts.append({"name": "deploy-config", "mountPath": CONFIG_FILES_MOUNT_PATH, "readOnly": True})

    # --- container env ---
    env: list[dict] = [
        {"name": "BROKER_URL", "value": f"http://agent-broker.{ns}.svc.cluster.local:8080"},
        {"name": "BROKER_TOKEN_PATH", "value": "/var/run/secrets/broker/token"},
        {"name": "HOME", "value": "/workspace"},
        {"name": "GIT_BROKER_HOST_MAP", "value": "github.com=github,gitlab.com=gitlab,test-git.local=test"},
    ]
    if aws_cm:
        env.append({"name": "AWS_ACCOUNTS_FILE", "value": "/etc/agent-sandbox/aws/accounts.json"})
    if deploy.public_url:
        base = deploy.public_url.rstrip("/")
        env.append({"name": "CONVERSATION_URL", "value": f"{base}/?thread={thread}"})
    env.append({"name": "CONVERSATION_ID", "value": thread})
    env += extra_env

    container: dict = {
        "name": "sandbox",
        "image": image,
        "imagePullPolicy": deploy.pull_policy,
        "volumeMounts": volume_mounts,
        "env": env,
    }
    if resources:
        container["resources"] = resources
    if systemd:
        # NON-privileged. `privileged` forces the HOST cgroup namespace, and the
        # sandbox's systemd PID 1 then churns the host /kubepods.slice tree at boot —
        # node instability, and on a workstation node a host-session logout (PR #255).
        # Isolation comes from runtimeClassName below (a cgroup-delegating runtime gives
        # PID 1 a writable subtree in the pod's OWN cgroup ns). SYS_ADMIN is still
        # required: NixOS stage-2 `specialfs` mounts /proc, /dev, /run at boot (mount(2)),
        # and under crun the cap does NOT re-introduce the host cgroup ns.
        container["securityContext"] = {"capabilities": {"add": ["SYS_ADMIN"]}}

    # --- pod volumes ---
    volumes: list[dict] = [
        {"name": "broker-token", "projected": {"sources": [{"serviceAccountToken": {"audience": audience, "path": "token"}}]}},
    ]
    if aws_cm:
        volumes.append({"name": "aws-accounts", "configMap": {"name": aws_cm}})
    if systemd:
        volumes += [
            {"name": "run", "emptyDir": {"medium": "Memory"}},
            {"name": "tmp", "emptyDir": {"medium": "Memory"}},
        ]
    if scooter_cm:
        volumes.append({"name": "scooter-tools", "configMap": {"name": scooter_cm}})
    if config_files:
        volumes.append({"name": "deploy-config", "configMap": {"name": config_files}})
    for aud in extra_auds:
        volumes.append({"name": f"tok-{aud}", "projected": {"sources": [{"serviceAccountToken": {"audience": aud, "path": "token"}}]}})

    # --- volumeClaimTemplates ---
    vcts: list[dict] = [
        {
            "metadata": {"name": "workspace"},
            "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": deploy.workspace_storage}}},
        }
    ]
    if overlay_store:
        vcts.append({
            "metadata": {"name": "scooter-rw"},
            "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": deploy.overlay_storage}}},
        })

    base = {
        "apiVersion": f"{GROUP}/{VERSION}",
        "kind": "Sandbox",
        "metadata": {"name": name, "namespace": ns, "labels": {SANDBOX_NAME_LABEL: name}},
        "spec": {
            "operatingMode": "Running",
            "podTemplate": {
                "metadata": {"labels": {SANDBOX_NAME_LABEL: name}},
                "spec": {
                    "serviceAccountName": service_account,
                    "automountServiceAccountToken": False,
                    # Cgroup-delegating runtime for the systemd sandbox — the other half
                    # of the non-privileged securityContext above (PR #255). Only for the
                    # systemd image, only when configured; else the cluster default.
                    **({"runtimeClassName": deploy.runtime_class} if systemd and deploy.runtime_class else {}),
                    "containers": [container],
                    "volumes": volumes,
                },
            },
            "volumeClaimTemplates": vcts,
        },
    }
    # Apply the consumer overlay LAST (deep-merge + re-assert Scooter's protected
    # fields). No overlay -> `base` unchanged. See overlay.py for merge semantics.
    if overlay:
        from .overlay import apply_overlay

        return apply_overlay(base, overlay)
    return base
