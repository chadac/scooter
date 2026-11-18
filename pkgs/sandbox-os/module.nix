{ config, lib, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) inputs;
  system = cfg.buildSystem;
  nix-stubs = import ../../modules/sandbox-os/nix-stubs-package.nix {
    inherit system;
    nixpkgs = cfg.buildPkgs.path;
    src = inputs.nix-stubs.outPath;
  };
  # The base stubs.nix's extra arguments, vendored for re-converge.
  stubArgs = { uvNixSrc = inputs.uv-nix.outPath; };
in
{
  scooter.config = {
    stubOverlayFor = deploymentModules:
      let contribSandbox = import ../../contrib/sandbox-modules.nix { inherit lib; extraModules = deploymentModules; };
      in import ../../modules/sandbox-os/stub-overlay.nix {
        inherit nix-stubs;
        lockLib = inputs.nix-stubs.lib;
        sets = contribSandbox.stubSets;
        stubArgs = lib.attrsets.unionOfDisjoint stubArgs contribSandbox.stubArgs;
      };
    stubOverlay = cfg.stubOverlayFor cfg.deploymentModules;
    sandboxPkgs = lib.mkDefault (import cfg.buildPkgs.path { inherit system; overlays = [ cfg.stubOverlay ]; });
    nixStubs = {
      src = inputs.nix-stubs;
      inherit stubArgs;
    };
  };

  # The NixOS dev-environment sandbox image (systemd as PID 1).
  scooter.images.agent-sandbox-os = {
    package = lib.mkDefault (import ./image.nix {
      inherit lib;
      inherit (cfg) n2c nixStubs deploymentModules;
      pkgs = cfg.sandboxPkgs;
    }).image;
    attr = "sandbox-os-image";
    refKey = "sandboxOs";
  };
}
