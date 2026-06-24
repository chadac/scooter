{ pkgs, lib, n2c, skillsDir, extraSkillsDirs ? [ ], extraPackages ? [ ], ... }:

# Generic Nix sandbox image — the "body".
#
# There is NO in-pod server. The agent-host drives this pod via the Kubernetes
# exec API (like upstream examples/sandboxed-tools), so the image just needs a
# Nix-powered environment that stays alive and is exec-able, with:
#   - a populated /nix store + initialized DB so `nix profile install` works
#   - skills available to the commands the agent-host runs
#   - the overlay-store entrypoint (writable /nix/store at runtime)
#
# Layered for cache efficiency (system / nix / app), patterns lifted from
# ../../../openhands-nix/pkgs/images.
#
# This image contains NO agent and NO agent-host — those run outside.

let
  # Container entrypoint: overlay-store setup, then `sleep infinity`.
  entrypoint = pkgs.writeShellApplication {
    name = "sandbox-entrypoint";
    runtimeInputs = [ pkgs.nix pkgs.cacert pkgs.coreutils pkgs.util-linux ];
    text = builtins.readFile ./entrypoint.sh;
  };

  # agent-broker: thin curl wrapper for calling the credential broker with the
  # pod's projected SA token (so `agent-broker test/whoami` Just Works).
  agentBroker = pkgs.writeShellApplication {
    name = "agent-broker";
    runtimeInputs = [ pkgs.curl pkgs.coreutils ];
    text = builtins.readFile ./agent-broker.sh;
  };

  # git-credential-broker: git credential helper that vends HTTPS git creds from
  # the broker (per-request, short-lived). Name MUST be git-credential-broker so
  # `git config credential.helper broker` resolves to it. See entrypoint.sh.
  gitCredentialBroker = pkgs.writeShellApplication {
    name = "git-credential-broker";
    runtimeInputs = [ pkgs.curl pkgs.jq pkgs.coreutils ];
    text = builtins.readFile ./git-credential-broker.sh;
  };

  # System tools available by default inside the sandbox.
  # cacert MUST be here (not only in the layer) so rootBinEnv links its
  # /etc/ssl/certs/ca-bundle.crt — without it HTTPS (git clone, curl) fails with
  # "unable to get local issuer certificate" (SSL_CERT_FILE points at a path the
  # symlink tree never created).
  systemPackages = with pkgs; [
    bashInteractive coreutils findutils gnugrep gnused gawk
    git curl jq gnutar gzip util-linux cacert
  ];

  allPackages = systemPackages ++ [ agentBroker gitCredentialBroker ] ++ extraPackages;

  # rootfs: non-package files baked into the image (skills, dirs).
  rootfs = pkgs.runCommand "sandbox-rootfs" { } ''
    mkdir -p $out/workspace
    # Skills (base + any extra dirs), available to exec'd commands.
    mkdir -p $out/etc/agent-sandbox/skills
    ${lib.concatMapStringsSep "\n"
      (d: "cp ${d}/*.md $out/etc/agent-sandbox/skills/ 2>/dev/null || true")
      ((lib.toList skillsDir) ++ extraSkillsDirs)}
  '';

  # /bin (and ssl/share) populated from the package set.
  rootBinEnv = pkgs.buildEnv {
    name = "sandbox-root-env";
    paths = allPackages;
    pathsToLink = [ "/bin" "/etc/ssl" "/share" ];
  };

  # Layer 1: system tools — change rarely.
  systemLayer = n2c.buildLayer { deps = allPackages ++ [ pkgs.cacert ]; };
  # Layer 2: nix itself — the package manager the agent uses in-pod.
  nixLayer = n2c.buildLayer { deps = [ pkgs.nix ]; };
  # Layer 3: app — entrypoint (thin, changes most).
  appLayer = n2c.buildLayer { deps = [ entrypoint ]; };
in
{
  inherit entrypoint;

  # nix build .#sandbox-image
  image = n2c.buildImage {
    name = "agent-sandbox-nix";
    tag = "latest";

    # Populate /nix/var/nix DB so `nix profile install` works at runtime.
    initializeNixDatabase = true;
    maxLayers = 80;

    layers = [ systemLayer nixLayer appLayer ];
    copyToRoot = [ rootfs rootBinEnv ];

    config = {
      Entrypoint = [ "${entrypoint}/bin/sandbox-entrypoint" ];
      Env = [
        "SKILLS_DIR=/etc/agent-sandbox/skills"
        "PATH=/bin:/usr/bin"
        "NIX_PATH=nixpkgs=${pkgs.path}"
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      ];
      WorkingDir = "/workspace";
      # No ExposedPorts: the pod is driven via the K8s exec API, not HTTP.
    };
  };
}
