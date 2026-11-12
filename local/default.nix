# `scooter-local`: local/scooter-local.sh with its tools and the renders baked in.
#
# Two shapes, one script:
# - the generic app (`nix run .#local`): every provider's render, chosen at `up`;
# - `scooter.lib.mkLocal { module }`: one render of the caller's configuration, with
#   the provider it names (`fixedProvider`), so `up` asks for nothing but a credential.
{ pkgs, lib, version, flake, manifests, agentSandboxVersion, fixedProvider ? "" }:
let
  # Only the build-time placeholders; the script keeps the renders' runtime ones
  # (@AGENT_HOST_CLAUDE_TAG@, @OLLAMA_HOST@, @OLLAMA_MODEL@) for `up` to fill in.
  vars = {
    "@version@" = version;
    "@flake@" = toString flake;
    "@agentSandboxVersion@" = agentSandboxVersion;
    "@fixedProvider@" = fixedProvider;
    "@manifestsClaudeCode@" = toString (manifests.claude-code or "");
    "@manifestsAnthropic@" = toString (manifests.anthropic or "");
    "@manifestsOllama@" = toString (manifests.ollama or "");
  };
  text = builtins.replaceStrings (builtins.attrNames vars) (builtins.attrValues vars)
    (builtins.readFile ./scooter-local.sh);
  app = pkgs.writeShellApplication {
    name = "scooter-local";
    runtimeInputs = with pkgs; [ k3d kubectl jq curl openssl coreutils gnused gnugrep ];
    inherit text;
    meta = {
      description = "Run Scooter on this machine, in a k3d cluster, from the published images";
      mainProgram = "scooter-local";
      platforms = lib.platforms.unix;
    };
  };
in
app // {
  # The YAML `up` applies, for `kubectl apply -f` against a cluster of one's own.
  inherit manifests;
  provider = fixedProvider;
}
