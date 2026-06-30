# nixosTest: a deployment's `.scooter/module.nix` (a real NixOS module) is applied
# to the RUNNING sandbox via switch-to-configuration — the runtime-converge
# mechanism. Proves: mount a module dir, run `scooter-apply-module`, and BOTH the
# module's package (on PATH) AND its systemd service go live, WITHOUT a reboot and
# without losing PID 1.
#
# This is the in-pod build+switch of a mounted NixOS module — the no-rebuild
# injection path: the module DECLARES its own tools (a lazy mkLazyTool tool here,
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

  # The nixpkgs source the in-pod build imports. Copy it into the store as a
  # concrete derivation output so it's a realised path the VM definitely has
  # (a bare `pkgs.path` source ref isn't reliably present in the VM store).
  nixpkgsSrc = pkgs.runCommand "nixpkgs-src" { } ''
    cp -r ${pkgs.path} $out
  '';

  # A module (written to the store) that pins the lazyTools/devEnvNix nixpkgs to
  # the test's offline source — layered into the re-converge so the rebuilt
  # toplevel doesn't default to nixos-unstable (a network ref) and the injected
  # lazy tool resolves offline. A real file path (not an inline string) avoids the
  # nested-quoting hazard of embedding it in scooter-apply-module's --expr.
  offlinePin = pkgs.writeText "pin-offline-nixpkgs.nix" ''
    { lib, ... }: {
      programs.lazyTools.defaultNixpkgs = lib.mkForce "${toString nixpkgsSrc}";
      devEnvNix.nixpkgs = lib.mkForce "${toString nixpkgsSrc}";
    }
  '';

  # Pre-build the re-converged toplevel (base config + the layered modules) so its
  # closure is in the VM store and the in-pod build is pure activation (offline).
  # MUST mirror what scooter-apply-module builds exactly — including the
  # keep-backdoor module threaded via extraReconvergeModules — or the in-pod build
  # is a cache miss and tries to build from source (offline -> hang/fail).
  reconverged = (import "${sandboxModule}/runtime-converge/base-config.nix" {
    nixpkgs = toString nixpkgsSrc;
    modulesPath = sandboxModule;
    system = pkgs.system;
    extraModules = [
      ({ lib, ... }: { programs.scooterModule.nixpkgs = lib.mkForce (toString nixpkgsSrc); })
      ./fixtures/keep-backdoor.nix
      "${offlinePin}"
      "${scooterFixture}/module.nix"
    ];
  }).toplevel;
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

    # LAYER the runtime re-converge on top of the running system. scooter-apply-
    # module builds its toplevel from the SHARED base config (modules/sandbox-os),
    # which does NOT include the nixosTest framework's `backdoor.service` (the test
    # control channel) — so without this, switch-to-configuration stops backdoor as
    # a "removed" unit, the driver loses its connection, and
    # `machine.succeed("scooter-apply-module")` HANGS to the 1h timeout. (This is
    # the pre-existing reason dev-env-scooter-module failed on main; a real pod has
    # no backdoor, so prod is unaffected.) extraReconvergeModules threads a module
    # into EVERY re-converge that re-declares backdoor + keeps it across the switch,
    # so the rebuilt toplevel reflects the currently-running system.
    # The re-converge always layers: keep-backdoor (so the test control channel
    # survives the switch) + the offline nixpkgs pin (so the injected lazy tool
    # resolves without network).
    programs.scooterModule.extraReconvergeModules = [
      "${./fixtures/keep-backdoor.nix}"
      "${offlinePin}"
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

    # AFTER: the injected (lazy) tool is on PATH and runs — the module declared it
    # via mkLazyTool, and it resolves nixpkgs#hello on first call (light: not in
    # the base closure). This is exactly how a deployment's module declares example-review.
    out = machine.succeed("scooter-demo")
    assert "Hello, world!" in out, f"injected lazy tool didn't run: {out!r}"
    # ...and the injected systemd service is active (full module power applied).
    machine.wait_for_unit("scooter-demo-service.service")

    # PID 1 (systemd) survived the switch — same process, same start time.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")
    pid1_after = machine.succeed("stat -c %Y /proc/1").strip()
    assert pid1_before == pid1_after, f"PID 1 was restarted by the switch ({pid1_before} -> {pid1_after})"
  '';
}
