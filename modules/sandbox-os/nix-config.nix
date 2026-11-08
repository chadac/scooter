# In-pod Nix configuration for the dev environment: flakes enabled, the per-user
# profile on PATH, and the `nixpkgs` flake registry pinned to a fixed nixpkgs so
# `nixpkgs#<pkg>` resolves deterministically. The dev-env-nix-build-skill nixosTest
# runs the nix-dev-env skill's documented commands against it.

{ config, lib, pkgs, ... }:

let
  cfg = config.devEnvNix;
  sandboxConf = "/run/nix-sandbox.conf";
in
{
  options.devEnvNix = {
    enable = lib.mkEnableOption "in-pod Nix for the agent (flakes, pinned registry, profile on PATH)";

    nixpkgs = lib.mkOption {
      type = lib.types.str;
      description = ''
        The nixpkgs the `nixpkgs` flake registry alias resolves to (a fixed ref,
        e.g. "github:NixOS/nixpkgs/<rev>"). Makes `nixpkgs#x` deterministic.
      '';
    };

    autoBuildSandbox = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Probe at boot whether a build can mount its own /proc inside a nested user
        namespace (true in a user-namespaced pod with an unmasked /proc, i.e.
        `scooter.sandboxUserNamespace`), and turn on Nix's build sandbox only if it
        can. A pod that fails the probe keeps building unsandboxed.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # 2.35 evaluates flakes without copying their source into the store.
    nix.package = lib.mkDefault pkgs.nixVersions.nix_2_35;

    nix.settings.experimental-features = [ "nix-command" "flakes" ];

    # Off unless nix-sandbox-probe finds the pod can host it and writes the include below.
    nix.settings.sandbox = false;
    # `!include` tolerates a missing file, so an unprobed pod reads only the setting above.
    nix.extraOptions = lib.mkIf cfg.autoBuildSandbox "!include ${sandboxConf}";

    systemd.services.nix-sandbox-probe = lib.mkIf cfg.autoBuildSandbox {
      description = "Enable the Nix build sandbox if this pod can host it";
      wantedBy = [ "multi-user.target" "nix-daemon.service" ];
      before = [ "nix-daemon.service" ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      path = [ pkgs.util-linux pkgs.coreutils ];
      # The namespaces Nix's sandbox unshares; a masked /proc is what refuses the mount.
      script = ''
        probe=/run/nix-sandbox-probe
        mkdir -p "$probe"
        if unshare --user --map-root-user --mount --pid --net --ipc --uts --fork \
             mount -t proc proc "$probe" 2>/dev/null; then
          echo "sandbox = true" > ${sandboxConf}
          echo "nix-sandbox-probe: build sandbox enabled"
        else
          rm -f ${sandboxConf}
          echo "nix-sandbox-probe: cannot mount a nested /proc; build sandbox stays off"
        fi
        rmdir "$probe" 2>/dev/null || true
      '';
    };

    # "" disables the global flake registry, so the pinned `nixpkgs` entry below is
    # the only source.
    nix.settings.flake-registry = "";

    # A path-flake ref (tests) pins to that store path; anything else is treated as
    # a github: ref.
    nix.registry.nixpkgs.to =
      if lib.hasPrefix "path:" cfg.nixpkgs
      then { type = "path"; path = lib.removePrefix "path:" cfg.nixpkgs; }
      else { type = "github"; owner = "NixOS"; repo = "nixpkgs"; };

    # Only reaches login shells; the non-login exec path inherits the container
    # image's Env.PATH (pkgs/sandbox-os), which prepends the profile bin itself.
    environment.sessionVariables.PATH = lib.mkAfter [ "$HOME/.nix-profile/bin" ];
  };
}
