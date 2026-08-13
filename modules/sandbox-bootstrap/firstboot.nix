# scooter-firstboot — the bootstrap's ONE job: switch to the real generation on boot.
#
# DESIGN BOILERPLATE — the unit SHAPE is defined; the switch itself lives in the SHARED
# scooter-rebuild derivation (pkgs/sandbox-shared/scooter-rebuild), consumed here. Design
# stage of the PoC process.
#
# The real system toplevel + its closure are ALREADY PRESENT in the overlay upper (the
# conversation's PVC is a clone of the golden VolumeSnapshot the warm Job produced). So
# firstboot does NOT build from scratch — scooter-rebuild resolves the agent-host directive
# ($SCOOTER_FIRSTBOOT_TARGET, a prebuilt store path present in the upper) and switches to it.
#
# ASYNC: the switch runs detached (scooter-rebuild switch --detach) so it does NOT gate
# multi-user.target / readiness — the pod is exec-reachable on the bootstrap immediately;
# the real generation lands when the switch finishes. A failed switch leaves the pod on the
# bootstrap (not bricked) + surfaces status; agent-host can retry.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterFirstboot;

  # The ONE switch command, shared with the real config's re-converge. A plain derivation,
  # not a module hook — it decides "resolve a prebuilt target vs build the flake" at runtime.
  scooterRebuild = pkgs.callPackage ../../pkgs/sandbox-shared/scooter-rebuild {
    inherit (cfg) configPath directiveEnv;
  };
  scooterEnvStatus = pkgs.callPackage ../../pkgs/sandbox-shared/scooter-env-status { };
in
{
  options.programs.scooterFirstboot = {
    enable = lib.mkEnableOption "the boot-time switch to the real generation";

    configPath = lib.mkOption {
      type = lib.types.str;
      default = "/etc/scooter/config";
      description = ''
        The root config flake to switch to (provided by the warmed PVC upper). Its
        flake.nix imports ./custom (the agent's workspace-PVC customizations). When there
        is no prebuilt directive, scooter-rebuild builds
        `path:<configPath>#sandboxSystem` and switches to it.
      '';
    };

    directiveEnv = lib.mkOption {
      type = lib.types.str;
      default = "SCOOTER_FIRSTBOOT_TARGET";
      description = ''
        Env var carrying the firstboot target: a /nix/store path (the prebuilt real
        toplevel, present in the cloned upper — the happy path, no build) or a URL serving
        a gzipped store path (the agent-host directive). Empty ⇒ build the config flake.
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
    # so there's exactly one scooter-rebuild implementation across both images).
    environment.systemPackages = [ scooterRebuild scooterEnvStatus ];

    systemd.services.scooter-firstboot = {
      description = "Switch to the real sandbox generation on boot (root + custom)";
      wantedBy = [ "multi-user.target" ];
      # After the overlay upper is mounted (prebuilt closure + config/root visible) and the
      # nix daemon is up (generation registration).
      after = [ "overlay-store-setup.service" "nix-daemon.socket" ];
      requires = [ "overlay-store-setup.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
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
