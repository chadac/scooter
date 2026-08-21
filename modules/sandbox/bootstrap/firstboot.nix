# scooter-firstboot — the bootstrap's ONE job: switch to the real generation on boot.
#
# The unit; the switch itself lives in the SHARED scooter-rebuild derivation
# (pkgs/sandbox-shared/scooter-rebuild), consumed here.
#
# The real system toplevel + its closure are ALREADY PRESENT in the overlay upper (the
# conversation's PVC is a clone of the golden VolumeSnapshot the warm Job produced). So
# firstboot does NOT build from scratch — scooter-rebuild resolves the agent-host
# directive ($SCOOTER_FIRSTBOOT_TARGET, a prebuilt store path in the upper) + switches to it.
#
# ASYNC: the switch runs detached (--detach) so it does NOT gate multi-user.target /
# readiness — the pod is exec-reachable on the bootstrap immediately; the real generation
# lands when the switch finishes. A failed switch leaves the pod on the bootstrap (not
# bricked) + surfaces status; agent-host can retry.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterFirstboot;

  # The ONE switch command, shared with the real config's re-converge. Decides at runtime:
  # resolve a prebuilt directive (prod) or build config/root+custom via impure --expr (fallback).
  # We do NOT pass `nixpkgs` — the bootstrap bakes no nixpkgs; the fallback build resolves
  # `<nixpkgs>` from the deploy's NIX_PATH/registry (prod uses the directive path anyway).
  scooterRebuild = pkgs.callPackage ../../../pkgs/sandbox-shared/scooter-rebuild {
    inherit (cfg) configPath directiveEnv;
  };
  scooterEnvStatus = pkgs.callPackage ../../../pkgs/sandbox-shared/scooter-env-status { };
in
{
  options.programs.scooterFirstboot = {
    enable = lib.mkEnableOption "the boot-time switch to the real generation";

    configPath = lib.mkOption {
      type = lib.types.str;
      default = "/etc/scooter/config";
      description = ''
        The config dir holding `root/` (the real config MODULE dir, baked/ConfigMap) and
        `custom/` (the agent's workspace-PVC modules, symlinked). When there is no prebuilt
        directive, scooter-rebuild builds the toplevel via `import
        <nixpkgs>/nixos/lib/eval-config.nix` over `[ root {isContainer} custom ]` — NO flake;
        nixpkgs is the k8s-pinned flake ref resolved by getFlake — and switches to it.
      '';
    };

    directiveEnv = lib.mkOption {
      type = lib.types.str;
      default = "SCOOTER_FIRSTBOOT_TARGET";
      description = ''
        Env var carrying the firstboot target: a /nix/store path (the prebuilt real
        toplevel, present in the cloned upper — the happy path, no build) or a URL serving
        a gzipped store path (the agent-host directive). Empty ⇒ build config/root+custom.
      '';
    };

    detach = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run the first switch detached (don't gate multi-user.target).";
    };
  };

  config = lib.mkIf cfg.enable {
    # Both shared commands on PATH (the real config puts the SAME derivations on PATH too,
    # so there's exactly one switch implementation across both images).
    environment.systemPackages = [ scooterRebuild scooterEnvStatus ];

    systemd.services.scooter-firstboot = {
      description = "Switch to the real sandbox generation on boot (root + custom)";
      wantedBy = [ "multi-user.target" ];
      # Order AFTER the overlay upper is mounted (prebuilt closure + config/root visible)
      # and the nix daemon is up (generation registration) — but only `wants`, not
      # `requires`: the overlay is a PROD deployment concern (the image enables it + the
      # provisioner mounts the PVC). If it's absent (a VM test, a bare run), firstboot still
      # runs — the switch just lands on whatever /nix/store is. A hard `requires` would
      # BLOCK firstboot forever when overlay-store-setup doesn't exist.
      after = [ "overlay-store-setup.service" "nix-daemon.socket" ];
      wants = [ "overlay-store-setup.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        # HOME on the /workspace PVC so `nix`'s flake fetcher/tarball caches (getFlake resolving
        # the pinned nixpkgs ref) are DURABLE — the first switch fetches nixpkgs once; every later
        # switch (and post-resume boot) is an offline sqlite→store lookup, no re-fetch. Matches the
        # HOME=/workspace convention the rest of the sandbox uses. The detached transient unit
        # inherits this env (systemd-run --property carries the ExecStart process's environment).
        Environment = [ "HOME=/workspace" ];
        # scooter-rebuild switch [--detach]. --detach backgrounds the switch as its own
        # transient unit so this oneshot returns immediately (readiness not gated).
        ExecStart = "${scooterRebuild}/bin/scooter-rebuild switch"
          + lib.optionalString cfg.detach " --detach";
      };
      # The directive env is passed by the provisioner (SCOOTER_FIRSTBOOT_TARGET). In a
      # deploy the agent-host sets it; the nixosTest sets it on this unit directly.
    };
  };
}
