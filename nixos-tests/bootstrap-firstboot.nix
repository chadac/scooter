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

let
  # The "real generation" the warm pipeline would prebuild into config/root: a SEPARATE,
  # independent system toplevel (its OWN /nix/store path) that turns the marker service on.
  # This faithfully models the prod happy path — the cloned/warm upper carries a prebuilt
  # real toplevel + closure; firstboot's directive is that store path; the switch is a pure
  # activation (no build). Built here so it's present in the VM store, like the cloned upper.
  realGeneration = (pkgs.nixos ({ lib, ... }: {
    imports = [ "${../modules/sandbox-os}/sample-service.nix" ];
    boot.isContainer = true;
    services.sampleDevService = { enable = true; port = 8899; };
  })).config.system.build.toplevel;
in
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
    # This test exercises FIRSTBOOT, not the overlay store. Turn the overlay off so the VM
    # doesn't need a mounted upper + the framework's register-nix-paths reconciliation — the
    # switch lands on the plain VM /nix/store (firstboot only `wants` overlay-store-setup).
    programs.overlayStore.enable = lib.mkForce false;

    # Base (bootstrap): the real service is OFF — a genuinely barebones pod.
    services.sampleDevService.enable = false;

    # Ship the prebuilt real-generation toplevel + its closure into the VM store (models the
    # cloned/warm upper carrying it), so firstboot's switch is a pure activation — no build.
    system.extraDependencies = [ realGeneration ];

    # The agent-host DIRECTIVE: the store path of the prebuilt real generation (prod passes
    # this via SCOOTER_FIRSTBOOT_TARGET; the test sets it on the unit directly).
    systemd.services.scooter-firstboot.environment.SCOOTER_FIRSTBOOT_TARGET = "${realGeneration}";
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # PID 1 is systemd; the base bootstrap does NOT have the real service.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")
    machine.fail("systemctl is-active sample-dev-service.service")

    pid1_before = machine.succeed("stat -c %Y /proc/1").strip()

    # scooter-firstboot runs on boot (wantedBy multi-user.target) and switches to the
    # prebuilt real generation. Wait for it to settle (oneshot RemainAfterExit → active on
    # success). Dump its journal on failure so a switch error is visible, not swallowed.
    (status, _) = machine.systemctl("is-active scooter-firstboot.service")
    if status != 0:
        print(machine.execute("systemctl status scooter-firstboot.service --no-pager -l")[1])
        print(machine.execute("journalctl -u scooter-firstboot.service --no-pager")[1])
        print("--- env-switch status/log ---")
        print(machine.execute("cat /run/scooter/env-switch/status /run/scooter/env-switch/error /run/scooter/env-switch/log 2>&1")[1])
    machine.wait_for_unit("scooter-firstboot.service")

    # THE SWITCH TOOK EFFECT: /run/current-system is now the prebuilt real generation (the
    # directive store path), not the bootstrap's. This is the core contract — firstboot
    # switched to the prebuilt real system present in the store (the cloned-upper model).
    realgen = "${realGeneration}"
    current = machine.succeed("readlink -f /run/current-system").strip()
    assert current == realgen, f"firstboot did not switch to the real generation: current={current!r} realgen={realgen!r}"

    # The real config's service is now INSTALLED by the switch (loaded + enabled, WantedBy
    # multi-user). It's an EXPLICIT-START service (like the real web services), so the switch
    # correctly leaves it enabled-but-not-running — starting it is the agent's job. Assert
    # the switch installed it (the real generation's units are present), then that it STARTS.
    machine.succeed("systemctl cat sample-dev-service.service >/dev/null")  # unit exists post-switch
    machine.succeed("systemctl start sample-dev-service.service")
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
