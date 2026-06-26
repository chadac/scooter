# In-pod Nix configuration for the dev environment.
#
# The agent builds/installs tools on demand, so nix must Just Work in-pod:
#   - flakes + the new CLI enabled;
#   - a writable per-user profile on PATH (so `nix profile install` lands on PATH);
#   - the `nixpkgs` flake registry PINNED to a fixed nixpkgs, so the documented
#     `nix profile install nixpkgs#<pkg>` (and the agent's ad-hoc `nix run
#     nixpkgs#<pkg>`) resolve deterministically — no mutable channel surprise.
#
# This is the foundation the nix-dev-env SKILL teaches against; the
# dev-env-nix-build-skill nixosTest runs the skill's documented commands.

{ config, lib, pkgs, ... }:

let
  cfg = config.devEnvNix;
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
  };

  config = lib.mkIf cfg.enable {
    nix.settings.experimental-features = [ "nix-command" "flakes" ];

    # Don't fetch the GLOBAL flake registry (channels.nixos.org) — the local
    # pinned `nixpkgs` entry below is the single source of truth, and fetching the
    # global one needs network + makes `nixpkgs#x` non-deterministic. "" disables it.
    nix.settings.flake-registry = "";

    # Pin `nixpkgs#…` to a fixed nixpkgs so the skill's documented install and the
    # agent's ad-hoc `nix run nixpkgs#…` resolve the same, deterministic tree.
    # When the ref is a path-flake (tests / local) pin to that store path;
    # otherwise treat it as a github: flake ref.
    nix.registry.nixpkgs.to =
      if lib.hasPrefix "path:" cfg.nixpkgs
      then { type = "path"; path = lib.removePrefix "path:" cfg.nixpkgs; }
      else { type = "github"; owner = "NixOS"; repo = "nixpkgs"; };

    # Ensure the per-user nix profile (where `nix profile install` puts things) is
    # on PATH for exec'd shells, so an installed tool is immediately runnable.
    environment.sessionVariables.PATH = lib.mkAfter [ "$HOME/.nix-profile/bin" ];
  };
}
