{ config, lib, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) inputs;
  system = cfg.buildSystem;
  nix-stubs = inputs.nix-stubs.packages.${system}.nix-stubs;
  # stubs.nix's arguments beyond `pkgs`, also vendored for the in-pod re-converge.
  stubArgs = { uvNixSrc = inputs.uv-nix.outPath; };
in
{
  scooter.config = {
    stubOverlay = import ../../modules/sandbox-os/stub-overlay.nix {
      inherit stubArgs nix-stubs;
      lockLib = inputs.nix-stubs.lib;
      flakeLock = ../../flake.lock;
    };
    sandboxPkgs = lib.mkDefault (import cfg.buildPkgs.path { inherit system; overlays = [ cfg.stubOverlay ]; });
    nixStubs = {
      src = inputs.nix-stubs;
      package = nix-stubs;
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
    # A handler wrapping the sandbox's own runtime, e.g. imageless-crun.
    imageless.runtimeClass = lib.mkIf ((config.scooter.sandboxRuntimeClass or null) != null)
      (lib.mkDefault "imageless-${config.scooter.sandboxRuntimeClass}");
  };
}
