# scooter-firstboot — the bootstrap's ONE job: switch to the real generation on boot.
#
# DESIGN BOILERPLATE — the unit + script SHAPE are defined; the switch body is STUBBED
# (`# IMPL:` markers). Design stage of the PoC process.
#
# The real system toplevel + its closure are ALREADY PRESENT in the overlay upper (the
# conversation's PVC is a clone of the golden VolumeSnapshot the warm Job produced; the
# Job built the real toplevel into the upper + dropped the config/root flake at
# /etc/scooter/config). So firstboot does NOT build from scratch — it realizes the
# root+custom generation (fast: closure present) and switches to it.
#
# ASYNC: the switch runs detached so it does NOT gate multi-user.target / the sandbox's
# readiness — the pod is exec-reachable on the bootstrap immediately; the real generation
# lands when the switch finishes. A failed switch leaves the pod on the bootstrap (not
# bricked) + surfaces status; agent-host can retry. Mirrors the current converge's
# health-gate + detach model (runtime-converge.nix).

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterFirstboot;
in
{
  options.programs.scooterFirstboot = {
    enable = lib.mkEnableOption "the boot-time switch to the real generation";

    configPath = lib.mkOption {
      type = lib.types.str;
      default = "/etc/scooter/config";
      description = ''
        The root config flake to switch to (provided by the warmed PVC upper). Its
        flake.nix imports ./custom (the agent's workspace-PVC customizations). The
        firstboot switch builds `<configPath>#<attr>` and switch-to-configurations to it.
      '';
    };

    # The agent-host DIRECTIVE: agent-host may pass the exact target (a store path to the
    # prebuilt toplevel, or a URL serving a gzipped expr) via this env var so the bootstrap
    # switches to the deployment's CURRENT real generation without the image knowing it.
    # Empty ⇒ fall back to building `configPath` from the upper's flake. (User: "agent-host
    # directive passed via an env var; expose a URL with the gzipped expression to build.")
    directiveEnv = lib.mkOption {
      type = lib.types.str;
      default = "SCOOTER_FIRSTBOOT_TARGET";
      description = "Env var carrying the firstboot target (store path or directive URL).";
    };

    detach = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run the first switch detached (don't gate multi-user.target).";
    };
  };

  config = lib.mkIf cfg.enable {
    # Turn on the SHARED switch core (modules/sandbox-common/scooter-switch.nix). The
    # bootstrap's scooter-rebuild is that core with a bootstrap-specific produceToplevel
    # hook — resolve the agent-host directive (a prebuilt store path present in the cloned
    # upper) OR build the config/root flake. Everything else (status protocol, --detach,
    # generation register, switch-in-scope, health-gate, rollback) is the shared library.
    programs.scooterSwitch.enable = true;

    # IMPL: scooter-rebuild = config.lib.scooter.mkSwitchCommand {
    #   name = "scooter-rebuild";
    #   extraRuntimeInputs = [ pkgs.curl pkgs.gzip ];
    #   produceToplevel = ''
    #     directive="''${${cfg.directiveEnv}:-}"
    #     if [ -n "$directive" ]; then
    #       case "$directive" in
    #         /nix/store/*) toplevel="$directive" ;;                 # prebuilt, in the upper
    #         http*://*)    toplevel=$(curl -fsSL "$directive" | gunzip | { read -r p; echo "$p"; }) ;;
    #       esac                                                     # (URL -> store path)
    #     else
    #       toplevel=$(nix build --no-link --print-out-paths \
    #         "path:${cfg.configPath}#sandboxSystem.config.system.build.toplevel")
    #     fi
    #   '';
    # };
    # environment.systemPackages = [ scooter-rebuild ];   # IMPL (via the shared builder)

    systemd.services.scooter-firstboot = {
      description = "Switch to the real sandbox generation on boot (root + custom)";
      wantedBy = [ "multi-user.target" ];
      # After the overlay upper is mounted (so the prebuilt closure + config/root are
      # visible) and the nix daemon is up (for the generation registration).
      after = [ "overlay-store-setup.service" "nix-daemon.socket" ];
      requires = [ "overlay-store-setup.service" ];
      # ConditionPathExists the config flake — if the upper didn't carry it (misprovisioned
      # / no clone), skip rather than fail-loop; agent-host surfaces the missing config.
      unitConfig.ConditionPathExists = "${cfg.configPath}/flake.nix";
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        # IMPL: pass --detach when cfg.detach so the switch backgrounds and this unit
        # returns immediately (readiness not gated). The detached child does the real
        # switch + maintains status (mirror runtime-converge's --detach re-exec).
        ExecStart = "${pkgs.coreutils}/bin/true # IMPL: scooter-rebuild switch ${cfg.configPath}"
          + lib.optionalString cfg.detach " --detach";
      };
    };
  };
}
