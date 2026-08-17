# nixosTest: firstboot BUILDS config/root#sandboxSystem in-pod, then switches.
#
# The second firstboot path (the first is bootstrap-firstboot.nix: a prebuilt-directive store
# path). Here there is NO directive → scooter-apply-module builds the config flake at
# /etc/scooter/config: `nix build path:<config>#sandboxSystem.config.system.build.toplevel` →
# switch. This proves the config/root + config/custom mechanism end-to-end.
#
# OFFLINE feasibility (like dev-env-scooter-module): a full sandboxSystem toplevel can't be
# built from source inside the VM. So we build it OUTSIDE + ship its closure + the nixpkgs
# source via system.extraDependencies — the in-VM `nix build` is then a CACHE HIT (realize an
# already-present, already-registered closure), not a from-source build. The flake pins
# nixpkgs by `path:` so the in-VM eval resolves offline + the derivation hash-matches the
# pre-seeded one.
#
# custom-layering: config/custom ships a no-op; this test asserts the ROOT config's marker
# service is installed by the switch (custom-override is a follow-up test).
#
# RED until: the config-root flake assembler + the scooter-apply-module flake-build branch are
# wired + offline-buildable in-VM.

{ pkgs, lib, bootstrapModule }:

let
  nixpkgsSrc = pkgs.runCommand "nixpkgs-src" { } ''cp -r ${pkgs.path} $out'';

  # The config/root flake (assembled), pinned at the test's nixpkgs so the in-VM build is
  # offline + reproducible. IMPL: pkgs/sandbox/config-root builds <out>/{flake.nix,root,custom}.
  configRoot = pkgs.callPackage ../pkgs/sandbox/config-root {
    nixpkgs = nixpkgsSrc;
  };

  # Pre-build sandboxSystem's toplevel OUTSIDE the VM so its closure can be seeded. MUST be the
  # IDENTICAL derivation the in-VM `nix build path:${configRoot}#sandboxSystem` produces — same
  # flake source, same nixpkgs. IMPL NOTE: evaluating the flake here (getFlake) vs. the in-VM
  # path: ref must yield the same drv; if they drift, the in-VM build goes from-source + hangs.
  sandboxSystem = (builtins.getFlake "path:${configRoot}").sandboxSystem;
  sandboxToplevel = sandboxSystem.config.system.build.toplevel;
in
pkgs.testers.runNixOSTest {
  name = "bootstrap-config-root";

  nodes.machine = { config, lib, pkgs, ... }: {
    imports = [ bootstrapModule ];

    programs.scooterFirstboot.enable = true;
    programs.scooterFirstboot.detach = lib.mkForce false;   # deterministic switch for asserts
    programs.overlayStore.enable = lib.mkForce false;        # testing firstboot, not the overlay

    # Mount the config/root flake at /etc/scooter/config (prod: the warm/cloned PVC upper).
    # tmpfiles symlink so the flake is at the path scooter-apply-module builds from.
    systemd.tmpfiles.rules = [
      "L+ /etc/scooter/config - - - - ${configRoot}"
    ];

    # Seed the pre-built closure + nixpkgs source so the in-VM `nix build` is a CACHE HIT
    # (realize, don't compile). configRoot itself + sandboxToplevel's closure + nixpkgsSrc.
    system.extraDependencies = [ nixpkgsSrc configRoot sandboxToplevel ];

    # NO SCOOTER_FIRSTBOOT_TARGET → the build branch (path:<config>#sandboxSystem).
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")

    # firstboot builds config/root#sandboxSystem + switches. Wait for it (oneshot, sync).
    (status, _) = machine.systemctl("is-active scooter-firstboot.service")
    if status != 0:
        print(machine.execute("journalctl -u scooter-firstboot.service --no-pager")[1])
        print(machine.execute("cat /run/scooter/env-switch/status /run/scooter/env-switch/error /run/scooter/env-switch/log 2>&1")[1])
    machine.wait_for_unit("scooter-firstboot.service")

    # THE SWITCH TOOK EFFECT: /run/current-system is the config/root sandboxSystem toplevel.
    expected = "${sandboxToplevel}"
    current = machine.succeed("readlink -f /run/current-system").strip()
    assert current == expected, f"firstboot did not switch to config/root#sandboxSystem: current={current!r} expected={expected!r}"

    # env-status ready.
    assert "ready" in machine.succeed("scooter-env-status")
  '';
}
