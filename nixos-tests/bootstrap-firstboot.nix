# nixosTest: the MINIMAL BOOTSTRAP switches to the real generation on boot.
#
# The core Tier-C contract: a barebones bootstrap image boots, and scooter-firstboot
# switches (async) to a PREBUILT toplevel that's already present in the store (in prod:
# the cloned/warm PVC upper the warm Job populated). The "real generation" here is
# represented by a specialisation that turns a marker service ON — standing in for the
# full sandbox-os config the warm pipeline prebuilds into config/root.
#
# Asserts:
#   - the bootstrap boots to default.target WITHOUT the real service (it's barebones),
#   - scooter-firstboot activates the prebuilt real generation (the marker service comes up),
#   - systemd is STILL PID 1 (the switch didn't re-exec the world),
#   - scooter-env-status reports ready/done after the switch (the shared status protocol).
#
# RED until: firstboot.nix's ExecStart is implemented (currently a /bin/true stub) + the
# shared scooter-switch core (mkSwitchCommand) is lifted from runtime-converge.nix.
#
# Mirrors switch-specialisation.nix (the live-switch primitive) but drives it through the
# BOOTSTRAP's scooter-firstboot unit + the agent-host directive, not a hand-exec'd switch.

{ pkgs, lib, bootstrapModule }:

pkgs.testers.runNixOSTest {
  name = "bootstrap-firstboot";

  nodes.machine = { config, lib, pkgs, ... }: {
    imports = [
      bootstrapModule                              # the barebones bootstrap config
      "${../modules/sandbox-os}/sample-service.nix" # the marker service MODULE (off in base)
    ];

    programs.scooterFirstboot.enable = true;
    # Synchronous in the test so the assertions don't race the async detach — the prod
    # default (detach = true) is exercised separately; here we want a deterministic switch.
    programs.scooterFirstboot.detach = lib.mkForce false;

    # Base (bootstrap): the real service is OFF — a genuinely barebones pod.
    services.sampleDevService.enable = false;

    # The "real generation" the warm pipeline would prebuild: a specialisation that turns
    # the service ON. In prod this is config/root's toplevel, present in the cloned upper;
    # here the specialisation toplevel is built into the VM store (already present, no
    # build) so firstboot's switch is a pure activation — exactly the prebuilt-toplevel model.
    specialisation.realGeneration.configuration = {
      services.sampleDevService = { enable = lib.mkForce true; port = 8899; };
    };

    # The agent-host DIRECTIVE: point firstboot at the prebuilt real-generation toplevel
    # (a bare store path — the prod happy path where the upper carries the closure). The
    # specialisation's toplevel lives at /run/current-system/specialisation/realGeneration.
    # (IMPL note: firstboot reads $SCOOTER_FIRSTBOOT_TARGET; the test sets it below.)
    systemd.services.scooter-firstboot.environment.SCOOTER_FIRSTBOOT_TARGET =
      "/run/current-system/specialisation/realGeneration";
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # PID 1 is systemd; the base bootstrap does NOT have the real service.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")
    machine.fail("systemctl is-active sample-dev-service.service")

    pid1_before = machine.succeed("stat -c %Y /proc/1").strip()

    # scooter-firstboot runs on boot (wantedBy multi-user.target) and switches to the
    # prebuilt real generation. Wait for it to finish, then the real service is up.
    machine.wait_for_unit("scooter-firstboot.service")
    machine.wait_for_unit("sample-dev-service.service")
    machine.wait_for_open_port(8899)

    # The switch reloaded the unit diff — it did NOT re-exec PID 1.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")
    pid1_after = machine.succeed("stat -c %Y /proc/1").strip()
    assert pid1_before == pid1_after, f"PID 1 was restarted by the firstboot switch ({pid1_before} -> {pid1_after})"

    # The shared status protocol reports ready after the switch (scooter-env-status,
    # provided by the shared scooter-switch core).
    st = machine.succeed("scooter-env-status")
    assert "ready" in st, f"env-status not ready after firstboot: {st!r}"
  '';
}
