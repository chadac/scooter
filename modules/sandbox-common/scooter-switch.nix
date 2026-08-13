# scooter-switch — the SHARED switch core (build-agnostic), used by BOTH:
#   - the bootstrap firstboot (modules/sandbox-bootstrap/firstboot.nix): switch to the
#     real generation (a directive store path, or config/root#sandboxSystem);
#   - the real config's runtime re-converge (modules/sandbox-os/runtime-converge.nix):
#     re-converge base + agent modules on a live apply / boot.
#
# DESIGN BOILERPLATE — the library BOUNDARY + the shared steps are defined; the two
# call sites' "produce the toplevel" hooks are the only difference. Implementation is the
# EXISTING switch body lifted out of runtime-converge.nix (status protocol, --detach
# re-exec, generation register, switch-in-scope, health-gate, rollback). Design stage.
#
# WHY a library, not a fork: today runtime-converge.nix owns the whole switch machinery.
# The bootstrap needs the SAME machinery minus the base-config build. Duplicating it would
# drift (the detach/cgroup + health-gate lessons are subtle). Factor the invariant core;
# each caller supplies only how the target toplevel is produced. (User: "scooter-rebuild
# shared between both.")

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterSwitch;
in
{
  options.programs.scooterSwitch = {
    enable = lib.mkEnableOption "the shared scooter-switch core library";

    # Canonical paths (were locals in runtime-converge.nix; now shared config).
    systemProfile = lib.mkOption {
      type = lib.types.str;
      default = "/nix/var/nix/profiles/system";
      description = "The system profile the switch registers each generation into (rollback ladder).";
    };
    statusDir = lib.mkOption {
      type = lib.types.str;
      default = "/run/scooter/env-switch";
      description = "Where the switch writes status/error/log (read by scooter-env-status).";
    };
  };

  config = lib.mkIf cfg.enable {
    # The library exposes ONE builder to consumers via config.lib.scooter.mkSwitchCommand:
    #
    #   mkSwitchCommand {
    #     name;                  # the CLI name (scooter-apply-module | scooter-rebuild)
    #     produceToplevel;       # SHELL snippet that sets $toplevel to a store path. This
    #                            #   is the ONLY per-caller difference:
    #                            #     - real config: `nix build --expr "(import <base>...)"`
    #                            #     - bootstrap:   resolve $SCOOTER_FIRSTBOOT_TARGET (a
    #                            #       store path) OR `nix build path:${config}#sandboxSystem`
    #     noopGuard ? "";        # optional snippet: exit idle if there's nothing to do
    #     extraRuntimeInputs ? [ ];
    #   }
    #   -> a pkgs.writeShellApplication that does, around produceToplevel:
    #        1. arg parse (--detach) + status/log protocol       (SHARED)
    #        2. --detach re-exec as a transient systemd unit      (SHARED — cgroup lesson)
    #        3. produceToplevel  ->  $toplevel                    (CALLER HOOK)
    #        4. record prev = /run/current-system; snapshot failed_before   (SHARED)
    #        5. nix-env -p <systemProfile> --set "$toplevel"      (SHARED)
    #        6. systemd-run --scope switch-to-configuration switch (SHARED)
    #        7. health-gate on NEW failed units -> rollback on regression   (SHARED)
    #        8. write_status done | failed                        (SHARED)
    #
    # IMPL: lift the body verbatim from runtime-converge.nix's applyModule (lines ~109-297),
    # replacing the inline "build toplevel" block (196-224) with the produceToplevel hook.
    # runtime-converge.nix then calls mkSwitchCommand with its base-config build snippet;
    # firstboot.nix calls it with the directive/flake snippet. scooter-env-status moves here
    # too (it only reads statusDir — shared verbatim).
    lib.scooter.mkSwitchCommand = lib.mkDefault (throw "IMPL: scooter-switch.mkSwitchCommand — see the boilerplate spec above");

    # scooter-env-status is pure status-reading (statusDir) — belongs here, shared by both
    # images. (IMPL: move from runtime-converge.nix verbatim.)
    environment.systemPackages = [
      # (pkgs.writeShellApplication { name = "scooter-env-status"; ... })   # IMPL
    ];
  };
}
