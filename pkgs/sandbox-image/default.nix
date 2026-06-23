{ pkgs, lib, n2c, skillsDir, ... }:

# Generic Nix sandbox image — the "body".
#
# There is NO in-pod server. The agent-host drives this pod via the Kubernetes
# exec API (like upstream examples/sandboxed-tools), so the image just needs a
# Nix-powered environment that stays alive and is exec-able.
#
# Patterns lifted from ../../../openhands-nix/pkgs/images:
#   - overlay /nix store (read-only base + writable overlayfs upper)
#   - lazy package shims (download big tools on first use)
#   - skills injected so they're available to commands run in the sandbox
#
# This image contains NO agent and NO agent-host — those run outside.
#
# Design stage: structure + inputs/outputs only; layers are sketched, not built.

let
  # Container entrypoint: overlay-store setup, then `sleep infinity`.
  entrypoint = pkgs.writeShellApplication {
    name = "sandbox-entrypoint";
    runtimeInputs = [ pkgs.nix pkgs.cacert pkgs.coreutils ];
    text = builtins.readFile ./entrypoint.sh;
  };

  basePackages = with pkgs; [ bashInteractive coreutils git curl jq gnutar gzip nix cacert ];

  # systemLayer / nixLayer / appLayer would be n2c.buildLayer calls here.
in
{
  inherit entrypoint;

  # nix build .#sandbox-image
  image = n2c.buildImage {
    name = "agent-sandbox-nix";
    tag = "latest";
    # initializeNixDatabase = true;
    # maxLayers = 80;
    # layers = [ systemLayer nixLayer appLayer ];
    copyToRoot = pkgs.buildEnv {
      name = "sandbox-root";
      paths = basePackages ++ [ entrypoint ];
      pathsToLink = [ "/bin" ];
    };
    config = {
      Entrypoint = [ "${entrypoint}/bin/sandbox-entrypoint" ];
      # Skills available to commands the agent-host execs in the sandbox.
      Env = [ "SKILLS_DIR=/etc/agent-sandbox/skills" ];
      WorkingDir = "/workspace";
      # No ExposedPorts: the pod is driven via the K8s exec API, not HTTP.
    };
    # Skills baked in (markdown; consumers can layer extra via extraSkillsDirs).
    # cp ${skillsDir}/*.md -> /etc/agent-sandbox/skills/  (in a layer)
  };
}
