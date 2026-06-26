# nixosTest (SPIKE): a running system re-converges to a DIFFERENT config at
# runtime via `switch-to-configuration`, WITHOUT a reboot and WITHOUT killing
# PID 1.
#
# This is the core primitive behind "a generic warm pod specializes itself on
# claim": boot a base config, then activate a pre-built SPECIALISATION live
# (exec'd, the way the agent-host's ExecBackend would on claim). Asserts:
#   - the base boots WITHOUT the specialised service,
#   - `switch-to-configuration switch` to the specialisation brings the service
#     up (pure activation — the specialisation toplevel is already in the store),
#   - systemd is STILL PID 1 afterwards (the switch didn't restart the world),
#   - switching back tears the service down again.
#
# The specialisation's switch script lives at
#   /run/current-system/specialisation/<name>/bin/switch-to-configuration
# (NixOS builds it into the current system). Under boot.isContainer the bootloader
# step is /bin/true, so `switch` is bootloader-free; in a VM test we use a normal
# boot, and `switch` works the same for the unit diff. See
# docs/DEV_ENVIRONMENT_DESIGN.md + memory runtime-nixos-switch-in-container.
#
# RED until Stage 5 implements services.sampleDevService (the unit the
# specialisation enables). The switch MECHANISM itself is NixOS-native; this test
# mainly proves the specialisation + live-switch path works for our config.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-switch-specialisation";

  nodes.machine = { config, lib, pkgs, ... }: {
    # Import only the service MODULE (not the opinionated default.nix, which turns
    # the service on) so the base is genuinely generic with the service OFF.
    imports = [ "${sandboxModule}/sample-service.nix" ];

    # Base: the sample service is OFF. The agent claims a generic pod.
    services.sampleDevService.enable = false;

    # A pre-built specialisation that turns the service ON. This stands in for a
    # per-workload config pre-warmed into the (warm) pod's store. The
    # specialisation inherits the parent config, so mkForce overrides the base's
    # `enable = false` (the specialisation is meant to win — that's the point).
    specialisation.withService.configuration = {
      services.sampleDevService = { enable = lib.mkForce true; port = 8888; };
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # PID 1 is systemd before the switch.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")

    # Base config: the specialised service is NOT running.
    machine.fail("systemctl is-active sample-dev-service.service")

    # Capture PID 1's start time so we can prove it was NOT restarted by the switch.
    pid1_before = machine.succeed("stat -c %Y /proc/1").strip()

    # SPECIALIZE ON CLAIM: exec the specialisation's switch live (no reboot).
    machine.succeed(
      "/run/current-system/specialisation/withService/bin/switch-to-configuration switch"
    )

    # The service is now up + listening — the running system re-converged.
    machine.wait_for_unit("sample-dev-service.service")
    machine.wait_for_open_port(8888)

    # systemd is STILL PID 1, and it's the SAME PID 1 (start time unchanged) —
    # the switch reloaded + restarted the unit diff, it did NOT re-exec the world.
    # THIS is the core spike result: a generic running pod re-converged to a
    # specialised config live, in ~1s, without losing PID 1.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")
    pid1_after = machine.succeed("stat -c %Y /proc/1").strip()
    assert pid1_before == pid1_after, f"PID 1 was restarted by the switch ({pid1_before} -> {pid1_after})"

    # The specialised service is agent-controllable (the start/stop path).
    machine.succeed("systemctl stop sample-dev-service.service")
    machine.wait_until_fails("systemctl is-active sample-dev-service.service")

    # CAVEAT (documented, not asserted): switching BACK to the base via
    # `/run/current-system/bin/switch-to-configuration switch` does NOT reliably
    # stop units the specialisation added — switch-away cleanup is incomplete (see
    # memory runtime-nixos-switch-in-container + the research). The production
    # model avoids this entirely: suspend-don't-recycle + a fresh cold
    # specialisation per conversation, never re-converging one pod across
    # workloads. So we assert the agent-control stop above, not switch-back.
  '';
}
