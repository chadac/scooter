{ pkgs, lib, n2c, skillsDir, ... }:

# Generic Nix sandbox image — the "body".
#
# Implements the agent-sandbox runtime contract (POST /execute, /upload,
# GET /download|/list|/exists on :8888) over a Nix-powered environment.
# Patterns lifted from ../../../openhands-nix/pkgs/images:
#   - overlay /nix store (read-only base + writable overlayfs upper)
#   - lazy package shims (download big tools on first use)
#   - skills injected so they're available to commands run in the sandbox
#
# Crucially this image contains NO agent and NO agent-host — those run outside.
# The agent-host drives this pod via the contract.
#
# Design stage: structure + inputs/outputs only; layers are sketched, not built.

let
  # The in-pod runtime server implementing the agent-sandbox contract.
  # (BYO server; reference impl is FastAPI on :8888. Ours adds the Nix env.)
  runtimeServer = pkgs.callPackage ./runtime-server { };

  # Container entrypoint: overlay-store setup + start the runtime server.
  entrypoint = pkgs.writeShellApplication {
    name = "sandbox-entrypoint";
    runtimeInputs = [ pkgs.nix pkgs.cacert runtimeServer ];
    text = builtins.readFile ./entrypoint.sh;
  };

  basePackages = with pkgs; [ bashInteractive coreutils git curl jq nix cacert ];

  # systemLayer / nixLayer / appLayer would be n2c.buildLayer calls here.
in
{
  inherit entrypoint runtimeServer;

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
      # Skills available to commands run in the sandbox.
      Env = [ "SKILLS_DIR=/etc/agent-sandbox/skills" ];
      WorkingDir = "/workspace";
      ExposedPorts = { "8888/tcp" = { }; };
    };
    # Skills baked in (markdown; consumers can layer extra via extraSkillsDirs).
    # cp ${skillsDir}/*.md -> /etc/agent-sandbox/skills/  (in a layer)
  };
}
