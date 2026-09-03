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
    # MUST mirror the broker's PLATFORM_DEFAULT (sandbox/resources.py): requests ==
    # limits (cpu AND memory) => Guaranteed QoS, so one runaway sandbox is hard-capped
    # and can't starve its neighbours (the "single bad pod blows up everything" case).
    # This file is the Nix-rendered contract for a directly-created Sandbox; a mismatch
    # drifts from what the provisioner produces at runtime.
  , sandboxResources ? { requests = { cpu = "2"; memory = "4Gi"; }; limits = { cpu = "2"; memory = "4Gi"; }; }
    # StorageClass for the durable /workspace PVC. Null = cluster default. A
    # Retain-reclaim class (e.g. "scooter-retain") keeps the data on disk if the
    # PVC is ever deleted. Mirrors platform.workspaceStorageClass.
  , workspaceStorageClass ? cfg.workspaceStorageClass or null
  }: {
    # ServiceAccount sandbox-${id}  (unique per conversation; broker identity)
    serviceAccount = {
      apiVersion = "v1";
      kind = "ServiceAccount";
      metadata = { name = "sandbox-${id}"; namespace = cfg.namespace; };
    };

    # Durable /workspace PVC — STANDALONE (owned by the agent-host, NOT the Sandbox)
    # and mounted by the pod via claimName. A Sandbox volumeClaimTemplate would be
    # controller-OWNED, so a Sandbox delete GC-cascades it and the provisioner's
    # Delete reclaim wipes the disk (observed data-loss on a node reboot). Kept
    # standalone, the volume survives Sandbox delete/recreate; a Retain StorageClass
    # is the second line of defense against an accidental PVC delete.
    workspacePvc = {
      apiVersion = "v1";
      kind = "PersistentVolumeClaim";
      metadata = {
        name = "workspace-conv-${id}";
        namespace = cfg.namespace;
        labels = { "agents.x-k8s.io/sandbox-name" = "conv-${id}"; };
      };
      spec = {
        accessModes = [ "ReadWriteOnce" ];
        resources.requests.storage = "10Gi";
      } // lib.optionalAttrs (workspaceStorageClass != null) {
        storageClassName = workspaceStorageClass;
      };
    };

    # Sandbox (cold): SA + claimName workspace volume + conversation-state PVC + broker token.
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
            ] ++ lib.optionals cfg.broker.aws.enable [
              # The AWS account registry — the entrypoint renders ~/.aws/config
              # from it (one [profile <name>] per account → the credential helper).
              { name = "aws-accounts"; mountPath = "/etc/agent-sandbox/aws"; readOnly = true; }
            ] ++ lib.optionals (cfg.deployTools.configFiles or { } != { }) [
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
            ] ++ lib.optionals cfg.broker.aws.enable [
              { name = "AWS_ACCOUNTS_FILE"; value = "/etc/agent-sandbox/aws/accounts.json"; }
            ];
          }];
          volumes = [
            {
              # Durable /workspace: an explicit claim on the standalone PVC above,
              # NOT a Sandbox volumeClaimTemplate — so it is not controller-owned
              # and survives Sandbox delete/recreate.
              name = "workspace";
              persistentVolumeClaim.claimName = "workspace-conv-${id}";
            }
            {
              name = "broker-token";
              projected.sources = [{ serviceAccountToken = { audience = brokerAudience; path = "token"; }; }];
            }
            # tmpfs for systemd's /run + /tmp (mirrors the provisioner).
            { name = "run"; emptyDir.medium = "Memory"; }
            { name = "tmp"; emptyDir.medium = "Memory"; }
          ] ++ lib.optionals cfg.broker.aws.enable [
            { name = "aws-accounts"; configMap.name = "agent-broker-aws-accounts"; }
          ] ++ lib.optionals (cfg.deployTools.configFiles or { } != { }) [
            { name = "deploy-config"; configMap.name = "deploy-config-files"; }
          ];
        };
        # volumeClaimTemplates holds ONLY rebuildable caches now. `workspace` is a
        # standalone PVC (above) mounted via claimName, deliberately NOT a template:
        # a template PVC is controller-owned and GC-cascades when the Sandbox is
        # deleted. Losing scooter-rw only triggers a re-converge, so its
        # GC-with-the-Sandbox is acceptable. Conversation-state PVC is mounted by the
        # agent-host, NOT here (it lives outside the sandbox).
        volumeClaimTemplates = lib.optionals overlayStore [{
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
