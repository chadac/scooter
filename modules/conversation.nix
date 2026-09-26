{ config, lib, ... }:

# Per-conversation resources: a COLD Sandbox carrying a unique ServiceAccount
# and two PVCs. This is the durable handle for a conversation.
#
# Design stage: this file documents the SHAPE the agent-host renders at runtime
# (the agent-host creates these per conversation via the kube API), and provides
# a `mkConversation` function the agent-host's provisioner mirrors.
#
# WHY cold + not warm-pooled (verified against agent-sandbox source):
#   - A SandboxClaim cannot override the SA; per-conversation SA must be in the
#     podTemplate of a directly-created Sandbox.
#   - Claim-level env/volumeClaimTemplates force a cold start anyway; we need
#     both per-conversation PVCs.
#   - Kept suspended (not deleted) -> resume recreates the pod from the same
#     template -> same SA + same PVCs -> broker re-validates same identity.

let
  inherit (lib) mkOption types;
  cfg = config.agentSandbox;

  # Shape of one conversation's resources. `id` = conversationId.
  mkConversation = { id, sandboxImage ? cfg.sandboxImage, brokerAudience ? "agent-broker", overlayStore ? false, overlayStorage ? "20Gi"
    # Default sandbox size: the preset marked `default = true` in cfg.sandboxSizes.
    # Requests == limits (Guaranteed QoS) so one runaway sandbox is hard-capped and
    # can't starve its neighbours. This is the Nix-rendered contract for a directly-
    # created Sandbox; the broker's PLATFORM_DEFAULT (resources.py) mirrors the
    # fallback used when a deployment configures no presets at all.
    # This lands in a k8s container `resources` block verbatim, so a GPU renders under
    # its extended-resource name (`nvidia.com/gpu`) on BOTH sides — k8s rejects a GPU
    # request that differs from its limit. The broker's render_resources does the same
    # for the runtime path.
  , sandboxResources ? let
      defaultPreset =
        if cfg.defaultSandboxSizeName == null
        # No presets configured: mirror the broker's PLATFORM_DEFAULT literally, so the
        # two paths that can create a Sandbox agree on the size.
        then { cpu = "2"; memory = "4Gi"; gpu = null; }
        else cfg.sandboxSizes.${cfg.defaultSandboxSizeName};
      side = { cpu = defaultPreset.cpu; memory = defaultPreset.memory; }
        // lib.optionalAttrs (defaultPreset.gpu != null) { "nvidia.com/gpu" = toString defaultPreset.gpu; };
    in { requests = side; limits = side; }
  }: {
    # ServiceAccount sandbox-${id}  (unique per conversation; broker identity)
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
        operatingMode = "Running"; # set "Suspended" to hibernate; keep object alive
        podTemplate.spec = {
          serviceAccountName = "sandbox-${id}";
          # automountServiceAccountToken default false -> project explicitly:
          automountServiceAccountToken = false;
          containers = [{
            name = "sandbox";
            image = sandboxImage;
            # Mirror the platform pullPolicy (the agent-host provisioner reads
            # SANDBOX_PULL_POLICY): "Always" for a registry, "IfNotPresent"/"Never"
            # for a side-loaded local cluster where "Always" fails ImagePullBackOff.
            imagePullPolicy = cfg.pullPolicy;
            resources = sandboxResources;
            ports = [{ containerPort = 8888; }];
            # The sandbox is the NixOS systemd-PID-1 image: systemd needs a
            # privileged context (writable cgroup + CAP_SYS_ADMIN). Mirrors the
            # agent-host k8sProvisioner (systemdImage=true, always). Tighten post-PoC.
            securityContext.privileged = true;
            volumeMounts = [
              { name = "workspace"; mountPath = "/workspace"; }
              { name = "broker-token"; mountPath = "/var/run/secrets/broker"; readOnly = true; }
              # systemd writes to /run + /tmp; back them with tmpfs (emptyDir).
              { name = "run"; mountPath = "/run"; }
              { name = "tmp"; mountPath = "/tmp"; }
            ] ++ lib.optionals overlayStore [
              # The local-overlay store's writable upper (disk-backed PVC). The
              # overlay-store image mounts the overlay onto /nix/store using this as
              # the upperdir; runtime nix builds (re-converge) land here + persist
              # across suspend/resume. Disk-backed PVC, never tmpfs.
              { name = "scooter-rw"; mountPath = "/nix/.scooter-rw"; }
            ] ++ cfg.sandboxPod.extraVolumeMounts
            ++ lib.optionals (cfg.deployTools.configFiles or { } != { }) [
              # Deployment config files as a flat read-only dir (filename -> contents).
              # File-based so multi-line config survives the CRD controller.
              { name = "deploy-config"; mountPath = "/etc/agent-sandbox/config"; readOnly = true; }
            ];
            env = [
              { name = "BROKER_URL"; value = "http://agent-broker.${cfg.namespace}.svc.cluster.local:8080"; }
              { name = "BROKER_TOKEN_PATH"; value = "/var/run/secrets/broker/token"; }
              # git config --global + exec'd git commands must share $HOME so the
              # broker credential helper is configured for both (image has no
              # /etc/passwd -> HOME would be "/"). Pin to the writable workspace.
              { name = "HOME"; value = "/workspace"; }
            ] ++ cfg.sandboxPod.extraEnv;
          }];
          volumes = [
            {
              name = "broker-token";
              projected.sources = [{ serviceAccountToken = { audience = brokerAudience; path = "token"; }; }];
            }
            # tmpfs for systemd's /run + /tmp (mirrors the provisioner).
            { name = "run"; emptyDir.medium = "Memory"; }
            { name = "tmp"; emptyDir.medium = "Memory"; }
          ] ++ cfg.sandboxPod.extraVolumes
          ++ lib.optionals (cfg.deployTools.configFiles or { } != { }) [
            { name = "deploy-config"; configMap.name = "deploy-config-files"; }
          ];
        };
        # Workspace PVC (body). Conversation-state PVC is mounted by the
        # agent-host, NOT here (it lives outside the sandbox).
        volumeClaimTemplates = [{
          metadata.name = "workspace";
          spec = {
            accessModes = [ "ReadWriteOnce" ];
            resources.requests.storage = "10Gi";
          };
        }] ++ lib.optionals overlayStore [{
          # The overlay-store upper PVC (disk-backed; persists runtime builds across
          # suspend/resume). Only when the overlay-store image is in use.
          metadata.name = "scooter-rw";
          spec = {
            accessModes = [ "ReadWriteOnce" ];
            resources.requests.storage = overlayStorage;
          };
        }];
        # NetworkPolicy: default-deny blocks RFC1918 -> add an egress allow to the
        # in-cluster broker (post-PoC, when broker lands). networkPolicyManagement
        # may need to be tuned or set Unmanaged.
      };
    };
  };
in
{
  # Exposed for the agent-host provisioner to mirror, and for tests.
  config._module.args.mkConversation = mkConversation;
}
