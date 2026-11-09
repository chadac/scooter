# The seams a contrib reaches the per-conversation sandbox pod through. Both
# renderers of the pod (modules/conversation.nix and the agent-host provisioner,
# via the manifest-overlay ConfigMap) read these same options, so they cannot
# disagree about what a contrib added.
{ lib, ... }:

let
  inherit (lib) mkOption types literalExpression;
in
{
  options.scooter.sandboxPod = {
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
    annotations = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Extra annotations on the sandbox pod.";
    };
    runtimeClassName = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "RuntimeClass for the sandbox pod, over `scooter.sandboxRuntimeClass`.";
    };
  };
}
