# nixosTest: a deployment's `.scooter/module.nix` (a real NixOS module) is applied
# to the RUNNING sandbox via switch-to-configuration — the runtime-converge
# mechanism. Proves: mount a module dir, run `scooter-apply-module`, and BOTH the
# module's package (on PATH) AND its systemd service go live, WITHOUT a reboot and
# without losing PID 1.
#
# This is the in-pod build+switch of a mounted NixOS module — the no-rebuild
# injection path: the module DECLARES its own tools (a tool it defines itself,
# the example-review pattern) + services, applied at runtime. See
# docs/SCOOTER_DIR_INJECTION.md.
#
# Heavy + hermetic: the in-pod `nix build` realises a new system toplevel offline,
# so we pre-seed the nixpkgs source + the re-converged toplevel's closure via
# system.extraDependencies. Production mounts `.scooter` from a ConfigMap; the
# build+switch code path is identical.

{ pkgs, lib, sandboxModule }:

let
  scooterFixture = ../nixos-tests/fixtures/scooter;

  # NOTE: devEnvNix.nixpkgs is pinned by base-config.nix itself (to `path:${nixpkgs}`,
  # the SAME source passed below), so the re-converge resolves OFFLINE against the
  # test's nixpkgs without a separate pin module here.

  # The nixpkgs source + the pre-built re-converged toplevel, from the file the fast
  # `dev-env-reconverge-eval` check shares — so that cheap per-PR check evaluates
  # the SAME expression this VM seeds. Pre-seeding the toplevel's closure is what
  # makes the in-pod build a pure CACHE HIT (offline activation) rather than a
  # from-source rebuild that hangs in the VM.
  reconverge = import ./reconverged.nix { inherit pkgs lib; };
  inherit (reconverge) nixpkgsSrc;
  reconverged = reconverge.toplevel;
in
pkgs.testers.runNixOSTest {
  name = "dev-env-scooter-module";

  nodes.machine = { config, pkgs, lib, ... }: {
    imports = [ sandboxModule ];

    # Enable runtime-converge (the image builder enables it in prod; here the
    # test imports the shared config directly, so turn it on explicitly).
    programs.scooterModule.enable = true;
    # Point the in-pod build at the test's own nixpkgs source (offline).
    programs.scooterModule.nixpkgs = lib.mkForce (toString nixpkgsSrc);
    # Don't auto-apply at boot — the test drives it explicitly so it can assert
    # the BEFORE (not applied) and AFTER (applied) states.
    programs.scooterModule.applyOnBoot = lib.mkForce false;

    # The mounted `.scooter` dir (a ConfigMap in prod). environment.etc makes it
    # available read-only at the module's expected path.
    environment.etc."agent-sandbox/scooter/module.nix".source =
      "${scooterFixture}/module.nix";

    # Pre-seed: the nixpkgs source + the re-converged closure so the in-pod build
    # is offline activation, not a from-source build. Also `hello` — the lazy tool
    # the injected module declares, so its first-call resolve works offline.
    system.extraDependencies = [ nixpkgsSrc reconverged pkgs.hello ];

    nix.settings.experimental-features = [ "nix-command" "flakes" ];
    virtualisation.diskSize = 6144;

    # Boot the bus the RE-CONVERGE will target. dbus-container.nix pins the classic
    # daemon (+ marks it survive-a-switch) only under `boot.isContainer`, on the
    # stated assumption that a VM can restart its bus cleanly — but base-config.nix
    # forces isContainer = true, so the toplevel this test switches TO is a container
    # config pinning classic dbus while the VM booted the stock broker. The switch
    # then replaces the system bus it is itself talking to: switch-to-configuration
    # dies mid-stop ("Failed to process dbus messages"), BEFORE activation, so
    # /run/current-system never moves and the injected module appears not to apply.
    # Pinning the same implementation here makes the unit match, and the base
    # config's own survive-a-switch flags then keep it running. Why: PR #610.
    services.dbus.implementation = lib.mkForce "dbus";

    # LAYER the runtime re-converge on top of the running system. scooter-apply-module
    # rebuilds from the SHARED base config (modules/sandbox-os), which in a VM differs
    # from what actually booted — so the switch acts on differences that exist only
    # here, several of which break the switch or the test. keep-vm-units.nix reconciles
    # them (the driver's backdoor channel, the boot-apply unit); see that file for each
    # case and why a pod is unaffected. The offline nixpkgs pin is no longer needed —
    # base-config pins devEnvNix to the same nixpkgs source automatically.
    programs.scooterModule.extraReconvergeModules = [
      "${./fixtures/keep-vm-units.nix}"
    ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # BEFORE: the injected package + service are NOT present (module not applied).
    machine.fail("command -v scooter-demo")
    machine.fail("systemctl cat scooter-demo-service.service")

    pid1_before = machine.succeed("stat -c %Y /proc/1").strip()

    # APPLY the mounted .scooter/module.nix via switch-to-configuration.
    machine.succeed("scooter-apply-module")

    # AFTER: the injected tool is on PATH and runs — the module declared it itself,
    # exactly how a deployment's module declares example-review.
    out = machine.succeed("scooter-demo")
    assert "Hello, world!" in out, f"injected tool did not run: {out!r}"
    # ...and the injected systemd service is active (full module power applied).
    machine.wait_for_unit("scooter-demo-service.service")

    # REGRESSION (scooter-rebuild-across-reconverge): the sandbox's OWN rebuild tools
    # must SURVIVE the switch — before the fix, base-config didn't keep
    # programs.scooterModule enabled, so scooter-rebuild / scooter-apply-module /
    # scooter-env-status dropped off PATH after the first re-converge and the agent
    # could no longer rebuild its environment.
    machine.succeed("command -v scooter-rebuild")
    machine.succeed("command -v scooter-apply-module")
    machine.succeed("command -v scooter-env-status")
    # They resolve into the NEW current-system profile (not a stale generation).
    machine.succeed("test \"$(command -v scooter-rebuild)\" = /run/current-system/sw/bin/scooter-rebuild")

    # PID 1 (systemd) survived the switch — same process, same start time.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")
    pid1_after = machine.succeed("stat -c %Y /proc/1").strip()
    assert pid1_before == pid1_after, f"PID 1 was restarted by the switch ({pid1_before} -> {pid1_after})"

    # ASYNC path: --detach returns immediately (background build+switch) and writes
    # the status/log protocol that scooter-env-status reads. Re-apply the same module
    # detached (idempotent), then poll to `done`.
    machine.succeed("scooter-apply-module --detach")   # returns fast, doesn't block
    # It reports a real state (building -> switching -> done) via the status file.
    machine.wait_until_succeeds("scooter-env-status | grep -q ready", timeout=120)
    # The status file lives where the agent-host completion watcher reads it.
    machine.succeed("test -f /run/scooter/env-switch/status")
    machine.succeed("test -f /run/scooter/env-switch/log")
    assert "done" in machine.succeed("cat /run/scooter/env-switch/status")

    # A second --detach WHILE one is in progress is refused (no overlapping switches):
    # simulate by planting an in-progress status, then confirm refusal (exit 3).
    machine.succeed("printf building > /run/scooter/env-switch/status")
    machine.fail("scooter-apply-module --detach")   # refused while building
    machine.succeed("printf done > /run/scooter/env-switch/status")  # restore
  '';
}
