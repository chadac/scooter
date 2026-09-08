# Which `uv` the sandbox runs.
#
# Two candidates, and the choice is not cosmetic:
#   uvNix       the uv-nix uv — patches wheels AND uv's managed Python binaries to
#               link against Nix-supplied libs, so `uv add numpy/scipy/matplotlib`
#               imports instead of dying on a missing libstdc++/BLAS.
#   pkgs.uv     vanilla nixpkgs uv (a nix-stubs shim). Everything above fails.
#
# So uvNix wins whenever the image supplied one; the stub is the fallback for a
# bare nixosTest, which has no flake input to supply it.
#
# It is an OPTION rather than just a PATH entry because a module that writes
# `pkgs.uv` gets the vanilla one — nixpkgs' attribute cannot be overlaid here
# (the image build goes through pkgs.nixos, whose `nixpkgs.pkgs` conflicts with
# `nixpkgs.overlays`; same constraint stub-set.nix documents). A service that
# needs the patched uv reads `config.sandboxOs.uv.package`.
#
# uvNix arrives as a derivation in the image build and as a `builtins.storePath`
# string in the in-pod re-converge (runtime-converge/base-config.nix). Both are
# valid `types.package` values, which is what lets the re-converge keep the
# patched uv without re-deriving it. See PR #503.

{ config, lib, pkgs, uvNix ? null, ... }:

{
  options.sandboxOs.uv.package = lib.mkOption {
    type = lib.types.package;
    default = if uvNix != null then uvNix else pkgs.uv;
    defaultText = lib.literalMD "the uv-nix uv when the image supplies one, else `pkgs.uv`";
    description = ''
      The uv the sandbox puts on PATH, and the one a module should reference when
      its service runs uv — `pkgs.uv` is vanilla nixpkgs uv and cannot resolve
      Nix-supplied native libraries for wheels.
    '';
  };

  # ONE uv in systemPackages. Two would collide in buildEnv, and which one won
  # would be decided by package priority rather than by this module.
  config.environment.systemPackages = [ config.sandboxOs.uv.package ];
}
