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


@dataclass
class DeployConfig:
    """Deployment-supplied provisioning config (was K8sProvisionerOptions on the
    agent-host; now broker-owned via env — see config.py)."""

    namespace: str
    sandbox_image: str
    workspace_storage: str = "10Gi"
    broker_audience: str = "agent-broker"
    overlay_store: bool = False
    overlay_storage: str = "20Gi"
    systemd_image: bool = True
    aws_accounts_configmap: str | None = None
    config_files_configmap: str | None = None
    extra_token_audiences: list[str] = field(default_factory=list)
    extra_env: list[dict] = field(default_factory=list)  # [{name, value}]
    public_url: str | None = None


def sandbox_manifest(
    *,
    conversation_id: str,
    name: str,
    service_account: str,
    deploy: DeployConfig,
    resources: dict | None = None,  # already-rendered k8s resources block
    url_thread: str | None = None,  # full threadId for CONVERSATION_URL deep-link
) -> dict:
    # NOTE: NO module ConfigMap. The pod pulls its module config (deployment defaults
    # + registry modules) as a tarball from the broker (a root sandbox-os Nix module
    # fetchTarballs it into /etc/scooter/modules on the workspace PVC), so there is no
    # per-conversation module CM and no deployment .scooter CM mount here.
    ns = deploy.namespace
    image = deploy.sandbox_image
    audience = deploy.broker_audience
    systemd = deploy.systemd_image
    overlay = deploy.overlay_store
    config_files = deploy.config_files_configmap
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
    for aud in extra_auds:
        volume_mounts.append({"name": f"tok-{aud}", "mountPath": f"/var/run/secrets/{aud}", "readOnly": True})
    if overlay:
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
        "imagePullPolicy": "Always",
        "volumeMounts": volume_mounts,
        "env": env,
    }
    if resources:
        container["resources"] = resources
    if systemd:
        container["securityContext"] = {"privileged": True}

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
    if overlay:
        vcts.append({
            "metadata": {"name": "scooter-rw"},
            "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": deploy.overlay_storage}}},
        })

    return {
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
                    "containers": [container],
                    "volumes": volumes,
                },
            },
            "volumeClaimTemplates": vcts,
        },
    }
