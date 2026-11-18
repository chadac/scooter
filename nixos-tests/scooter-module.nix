# nixosTest: a mounted `.scooter/module.nix` is applied to the running sandbox by
# `scooter-apply-module`, and both its package and its systemd service go live
# without a reboot and without losing PID 1. The in-pod `nix build` runs offline,
# so the nixpkgs source and the re-converged toplevel's closure are pre-seeded via
# system.extraDependencies.

{ pkgs, lib, sandboxModule }:

let
  scooterFixture = ../nixos-tests/fixtures/scooter;

  # The nixpkgs source and the pre-built re-converged toplevel, shared with the
  # `dev-env-reconverge-eval` check so both evaluate the same expression.
  reconverge = import ./reconverged.nix { inherit pkgs lib; };
  inherit (reconverge) nixpkgsSrc;
  reconverged = reconverge.toplevel;
in
pkgs.testers.runNixOSTest {
  name = "dev-env-scooter-module";

  nodes.machine = { config, pkgs, lib, ... }: {
    imports = [ sandboxModule ] ++ reconverge.contribSandbox.modules;

    # The out-of-tree contrib wired as pkgs/sandbox-os wires one.
    programs.scooterModule.contribSrcs = reconverge.contribSandbox.outOfTreeSrcs;
    programs.scooterModule.extraReconvergeModuleFiles = reconverge.contribSandbox.treeRelative;

    programs.scooterModule.enable = true;
    # Point the in-pod build at the test's own nixpkgs source.
    programs.scooterModule.nixpkgs = lib.mkForce (toString nixpkgsSrc);
    # The test applies the module itself so it can assert the before and after states.
    programs.scooterModule.applyOnBoot = lib.mkForce false;

    # The mounted `.scooter` dir, a ConfigMap in production.
    environment.etc."agent-sandbox/scooter/module.nix".source =
      "${scooterFixture}/module.nix";

    # Pre-seed the closures the in-pod build needs offline, including `hello`, the lazy tool the module declares.
    system.extraDependencies = [ nixpkgsSrc reconverged pkgs.hello ];

    nix.settings.experimental-features = [ "nix-command" "flakes" ];
    virtualisation.diskSize = 6144;

    # Boot the same dbus implementation the re-converged (container) toplevel pins, or the switch replaces the bus it is talking to and dies before activation.
    services.dbus.implementation = lib.mkForce "dbus";

    # Layer the same VM-reconciling modules the seeded toplevel uses (see fixtures/keep-vm-units.nix) so the in-pod build reproduces it exactly.
    programs.scooterModule.extraReconvergeModules = map (m: "${m}") reconverge.vmModules;
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # Before: the injected package and service are absent.
    machine.fail("command -v scooter-demo")
    machine.fail("systemctl cat scooter-demo-service.service")

    # The out-of-tree contrib is in the booted system.
    def assert_contrib_ext():
        assert "contrib-ext-demo ran" in machine.succeed("contrib-ext-demo")
        assert "Hello from outside the tree." in machine.succeed("cat /etc/scooter/contrib-ext-demo")
    assert_contrib_ext()

    pid1_before = machine.succeed("stat -c %Y /proc/1").strip()

    # Apply the mounted .scooter/module.nix via switch-to-configuration.
    machine.succeed("scooter-apply-module")

    # After: the injected tool is on PATH and runs.
    out = machine.succeed("scooter-demo")
    assert "Hello, world!" in out, f"injected tool did not run: {out!r}"
    # The injected systemd service is active.
    machine.wait_for_unit("scooter-demo-service.service")

    # The contrib survives, and the pod built the predicted toplevel.
    assert_contrib_ext()
    current = machine.succeed("readlink -f /run/current-system").strip()
    assert current == "${reconverged}", f"the pod built {current}, not the pre-built ${reconverged}"

    # The sandbox's own rebuild tools must survive the switch.
    machine.succeed("command -v scooter-rebuild")
    machine.succeed("command -v scooter-apply-module")
    machine.succeed("command -v scooter-env-status")
    # They resolve into the new current-system profile.
    machine.succeed("test \"$(command -v scooter-rebuild)\" = /run/current-system/sw/bin/scooter-rebuild")

    # PID 1 survived the switch: same process, same start time.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")
    pid1_after = machine.succeed("stat -c %Y /proc/1").strip()
    assert pid1_before == pid1_after, f"PID 1 was restarted by the switch ({pid1_before} -> {pid1_after})"

    # Async path: --detach returns immediately and writes the status/log files that scooter-env-status reads.
    machine.succeed("scooter-apply-module --detach")
    machine.wait_until_succeeds("scooter-env-status | grep -q ready", timeout=120)
    # The status file lives where the agent-host completion watcher reads it.
    machine.succeed("test -f /run/scooter/env-switch/status")
    machine.succeed("test -f /run/scooter/env-switch/log")
    assert "done" in machine.succeed("cat /run/scooter/env-switch/status")

    # A second --detach while one is in progress is refused; simulate by planting an in-progress status.
    machine.succeed("printf building > /run/scooter/env-switch/status")
    machine.fail("scooter-apply-module --detach")
    machine.succeed("printf done > /run/scooter/env-switch/status")
  '';
}
