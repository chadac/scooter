# The seams a contrib reaches the per-conversation sandbox pod through. Both
# renderers of the pod (modules/conversation.nix and the agent-host provisioner,
# via the manifest-overlay ConfigMap) read these same options, so they cannot
# disagree about what a contrib added.
{ lib, ... }:

let
  inherit (lib) mkOption types literalExpression;
  gitIdentityGuard = import ./git-identity-env-guard.nix { inherit lib; };
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

        GIT_AUTHOR_* / GIT_COMMITTER_* are rejected: they would override the
        commit identity the sandbox reads from the broker.
      '';
      apply = gitIdentityGuard "scooter.sandboxPod.extraEnv";
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
