# Which packages are nix-stubs SHIMS, as options — so a deployment can point the
# in-pod re-converge at its OWN stub set instead of this repo's.
#
# The two files move together: mkOverlay iterates the LOCK, so a declaration with
# no lock entry is never applied. Regenerate a pair with
# `nix run github:chadac/nix-stubs#gen`. See PR #502.

{ config, lib, stubBits, ... }:

let
  cfg = config.sandboxOs.stubs;
in
{
  options.sandboxOs.stubs = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Replace each package declared in `declarations` with a nix-stubs shim,
        which carries the build recipe instead of the package.
      '';
    };

    declarations = lib.mkOption {
      type = lib.types.path;
      default = ./stubs.nix;
      description = "stubs.nix — the stub set: what to make lazy, and where each package comes from.";
    };

    lock = lib.mkOption {
      type = lib.types.path;
      default = ./stubs.lock;
      description = ''
        stubs.lock — the recorded .drv for each declaration. Must be synced to the
        flake.lock the image was built from; mkOverlay throws if it is not.
      '';
    };
  };

  # `stubBits` is null in every eval EXCEPT the in-pod re-converge, which is the
  # only one that both has the vendored nix-stubs and can set this option: the
  # image build goes through pkgs.nixos, whose `nixpkgs.pkgs` conflicts with
  # `nixpkgs.overlays`, so it applies the same overlay at pkgs construction.
  config = lib.mkIf (cfg.enable && stubBits != null) {
    nixpkgs.overlays = [
      (import ./stub-overlay.nix {
        inherit (stubBits) lockLib flakeLock nix-stubs;
        stubs = cfg.declarations;
        inherit (cfg) lock;
      })
    ];
  };
}
