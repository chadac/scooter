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
  mkConversation = { id, sandboxImage ? cfg.sandboxImage, brokerAudience ? "agent-broker" }: {
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
            ports = [{ containerPort = 8888; }];
            volumeMounts = [
              { name = "workspace"; mountPath = "/workspace"; }
              { name = "broker-token"; mountPath = "/var/run/secrets/broker"; readOnly = true; }
            ] ++ lib.optionals cfg.broker.aws.enable [
              # The AWS account registry — the entrypoint renders ~/.aws/config
              # from it (one [profile <name>] per account → the credential helper).
              { name = "aws-accounts"; mountPath = "/etc/agent-sandbox/aws"; readOnly = true; }
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
          volumes = [{
            name = "broker-token";
            projected.sources = [{ serviceAccountToken = { audience = brokerAudience; path = "token"; }; }];
          }] ++ lib.optionals cfg.broker.aws.enable [
            { name = "aws-accounts"; configMap.name = "agent-broker-aws-accounts"; }
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
