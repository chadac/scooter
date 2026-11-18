# Rebuilds the image's stub overlay in the in-pod re-converge.

{ config, lib, stubBits, ... }:

let
  cfg = config.sandboxOs.stubs;
in
{
  options.sandboxOs.stubs.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = ''
      Replace each package the active stub sets declare with a nix-stubs shim,
      which carries the build recipe instead of the package.
    '';
  };

  # `stubBits` is null in every eval except the in-pod re-converge.
  config = lib.mkIf (cfg.enable && stubBits != null) {
    nixpkgs.overlays = [
      (import ./stub-overlay.nix { inherit (stubBits) lockLib nix-stubs sets stubArgs; })
    ];
  };
}
