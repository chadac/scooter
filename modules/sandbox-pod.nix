# How a contrib reaches the per-conversation SANDBOX pod.
#
# The sandbox pod is rendered TWICE from one shape: modules/conversation.nix (the
# Nix mirror) and services/agent-host/src/session/k8sProvisioner.ts (the runtime
# path that actually creates the Sandbox CR). Before this, aws was spelled into
# both by hand — three `lib.optionals cfg.broker.aws.enable` blocks here and three
# `awsAccountsConfigMap ? [...] : []` blocks there — so one integration's account
# registry was a property of the platform's pod shape, in two files that could
# drift. Why: #599.
#
# These are the seams it contributes through instead. Same shape as the broker's
# (modules/broker.nix, PR #636) and for the same reason: lists, because that is the
# k8s shape, and a contrib emits only what its own `enable` gates.
#
# The two consumers read ONE option, so they cannot disagree about what a contrib
# added. The agent-host gets it through the mechanism it ALREADY has for splicing k8s
# fragments into that manifest — the manifest-overlay ConfigMap (modules/platform.nix
# renders these parts into its `contrib.yaml` key). The provisioner therefore learns
# nothing about contribs: no payload type, no parser, no per-integration env var.
{ lib, ... }:

let
  inherit (lib) mkOption types literalExpression;
in
{
  options.agentSandbox.sandboxPod = {
    extraEnv = mkOption {
      type = types.listOf (types.attrsOf types.anything);
      default = [ ];
      example = literalExpression ''[ { name = "AWS_ACCOUNTS_FILE"; value = "/etc/agent-sandbox/aws/accounts.json"; } ]'';
      description = ''
        Extra env entries on the sandbox container. A contrib must own its prefix:
        a name declared twice is not an error and k8s silently keeps the last.

        Merged UNDER the consumer's deployTools.sandboxManifestOverlay, so a
        deployment can still override a contrib's value by name
        (session/sandboxOverlay.ts merges env strategically).
      '';
    };
    extraVolumes = mkOption {
      type = types.listOf (types.attrsOf types.anything);
      default = [ ];
      description = "Extra volumes on the sandbox pod (a contrib's ConfigMap mount).";
    };
    extraVolumeMounts = mkOption {
      type = types.listOf (types.attrsOf types.anything);
      default = [ ];
      description = "Extra volumeMounts on the sandbox container, paired with extraVolumes.";
    };
  };
}
