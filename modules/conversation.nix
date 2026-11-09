{ config, lib, ... }:

# Per-conversation resources: a cold Sandbox carrying a unique ServiceAccount
# and two PVCs, the durable handle for a conversation. The agent-host creates
# these at runtime via the kube API; `mkConversation` is the shape its
# provisioner mirrors. A suspended Sandbox resumes from the same template, so
# the broker sees the same SA and PVCs.

let
  inherit (lib) mkOption types;
  cfg = config.scooter;

  # Shape of one conversation's resources, keyed by conversationId.
  mkConversation = { id, sandboxImage ? cfg.sandboxImage, brokerAudience ? "agent-broker", overlayStore ? false
    # From scooter.sandbox.volumes, keyed by claim name.
  , volumeClaims ? cfg.sandbox.renderedVolumeClaims
    # The default size preset rendered with requests == limits (Guaranteed QoS), including a GPU under its extended-resource name on both sides.
  , sandboxResources ? let
      defaultPreset =
        if cfg.defaultSandboxSizeName == null
        # Mirrors the broker's PLATFORM_DEFAULT so both Sandbox-creating paths agree.
        then { cpu = "2"; memory = "4Gi"; gpu = null; }
        else cfg.sandboxSizes.${cfg.defaultSandboxSizeName};
      side = { cpu = defaultPreset.cpu; memory = defaultPreset.memory; }
        // lib.optionalAttrs (defaultPreset.gpu != null) { "nvidia.com/gpu" = toString defaultPreset.gpu; };
    in { requests = side; limits = side; }
  }: {
    # Unique per conversation; the broker identity.
    serviceAccount = {
      apiVersion = "v1";
      kind = "ServiceAccount";
      metadata = { name = "sandbox-${id}"; namespace = cfg.namespace; };
    };

    # Sandbox (cold): SA + workspace PVC + conversation-state PVC + broker token.
    sandbox = {
      apiVersion = "agents.x-k8s.io/v1beta1";
      kind = "Sandbox";
      metadata = { name = "conv-${id}"; namespace = cfg.namespace; };
      spec = {
        operatingMode = "Running"; # "Suspended" hibernates while keeping the object alive.
        podTemplate.metadata = lib.optionalAttrs (cfg.sandboxPod.annotations != { }) {
          inherit (cfg.sandboxPod) annotations;
        };
        podTemplate.spec = lib.optionalAttrs (cfg.sandboxPod.runtimeClassName != null) {
          inherit (cfg.sandboxPod) runtimeClassName;
        } // {
          serviceAccountName = "sandbox-${id}";
          # The broker token is projected explicitly below.
          automountServiceAccountToken = false;
          containers = [{
            name = "sandbox";
            image = sandboxImage;
            # Mirrors the platform pullPolicy the agent-host provisioner reads from SANDBOX_PULL_POLICY.
            imagePullPolicy = cfg.pullPolicy;
            resources = sandboxResources;
            ports = [{ containerPort = 8888; }];
            # systemd as PID 1 needs a writable cgroup and CAP_SYS_ADMIN.
            securityContext.privileged = true;
            volumeMounts = [
              { name = "workspace"; mountPath = "/workspace"; }
              { name = "broker-token"; mountPath = "/var/run/secrets/broker"; readOnly = true; }
              # systemd writes to /run and /tmp, backed by tmpfs.
              { name = "run"; mountPath = "/run"; }
              { name = "tmp"; mountPath = "/tmp"; }
            ] ++ lib.optionals overlayStore [
              # The local-overlay store's writable upper, a disk-backed PVC where runtime nix builds persist across suspend/resume.
              { name = "scooter-rw"; mountPath = "/nix/.scooter-rw"; }
            ] ++ cfg.sandboxPod.extraVolumeMounts
            ++ lib.optionals (cfg.deployTools.configFiles or { } != { }) [
              # Deployment config files as a flat read-only dir, so multi-line config survives the CRD controller.
              { name = "deploy-config"; mountPath = "/etc/agent-sandbox/config"; readOnly = true; }
            ];
            env = [
              { name = "BROKER_URL"; value = "http://agent-broker.${cfg.namespace}.svc.cluster.local:8080"; }
              { name = "BROKER_TOKEN_PATH"; value = "/var/run/secrets/broker/token"; }
              # `git config --global` and exec'd git commands must share a writable $HOME for the broker credential helper.
              { name = "HOME"; value = "/workspace"; }
            ] ++ cfg.sandboxPod.extraEnv;
          }];
          volumes = [
            {
              name = "broker-token";
              projected.sources = [{ serviceAccountToken = { audience = brokerAudience; path = "token"; }; }];
            }
            # tmpfs for systemd's /run and /tmp.
            { name = "run"; emptyDir.medium = "Memory"; }
            { name = "tmp"; emptyDir.medium = "Memory"; }
          ] ++ cfg.sandboxPod.extraVolumes
          ++ lib.optionals (cfg.deployTools.configFiles or { } != { }) [
            { name = "deploy-config"; configMap.name = "deploy-config-files"; }
          ];
        };
        # The workspace PVC; the conversation-state PVC is mounted by the agent-host, not here.
        volumeClaimTemplates = [ volumeClaims.workspace ]
          # The overlay-store upper PVC, only when the overlay-store image is in use.
          ++ lib.optional overlayStore volumeClaims.scooter-rw;
      };
    };
  };
in
{
  # Exposed for the agent-host provisioner to mirror, and for tests.
  config._module.args.mkConversation = mkConversation;
}
