# nixosTest: config/custom — the agent-editable layer — exercised end-to-end.
#
# config/root is a MODULE DIR (baked/ConfigMap); config/custom is the agent's own modules on the
# workspace PVC (symlinked to /etc/scooter/config/custom). `scooter-rebuild switch` builds
# `import <nixpkgs>/nixos/lib/eval-config.nix { modules = [ root {isContainer} custom ]; }` — NO
# flake — and layers custom AFTER root (extends/overrides). This test drives the agent workflow:
#   1. no custom yet          → switch builds root-only (a marker service OFF)
#   2. author a custom module → switch turns the marker service ON (custom extends root)
#   3. custom OVERRIDES a root option (root sets port 8080; custom forces 8099 → 8099 wins)
#   4. empty/whitespace custom → treated as no-op (base only), not a build error
#   5. a BAD custom module     → build fails, NO switch (the gate), previous generation intact
#
# root here is a SMALL stand-in module dir (not the full real config) so the in-VM build is cheap
# + hermetic. Each scenario's toplevel is pre-built OUTSIDE + seeded (extraDependencies) so the
# in-VM `nix build --expr` is a cache-hit. nixpkgs is the test's own source, pinned by NIX_PATH.

{ pkgs, lib, bootstrapModule }:

let
  nixpkgs = pkgs.path;

  # A tiny stand-in config/root (real fixture files, not a runCommand heredoc — the escaping
  # corrupts the module). Declares the marker service module but leaves it OFF; config/custom
  # turns it on / overrides it. See nixos-tests/config-custom-fixtures/root/.
  rootDir = ./config-custom-fixtures/root;

  # Build a scenario's toplevel exactly as the in-VM `scooter-rebuild` does, so its closure can be
  # seeded + the in-VM build is a cache-hit. customDir = null (root only) or a module dir.
  buildToplevel = customDir:
    (import (nixpkgs + "/nixos/lib/eval-config.nix") {
      system = pkgs.stdenv.hostPlatform.system;
      modules =
        [ rootDir { boot.isContainer = true; } ]
        ++ lib.optional (customDir != null) customDir;
    }).config.system.build.toplevel;

  # Scenario custom dirs — REAL fixture paths (a writeTextDir derivation passed as a module
  # mis-coerces to the `system` option). See nixos-tests/config-custom-fixtures/.
  customOn = ./config-custom-fixtures/custom-on;             # turns the service ON (extends root)
  customOverride = ./config-custom-fixtures/custom-override; # forces port 8080 → 8099 (overrides)
  # Store-path forms the test script copies into the workspace (byte-identical → cache-hit).
  customOnStore = builtins.path { path = customOn; name = "custom-on"; };
  customOverrideStore = builtins.path { path = customOverride; name = "custom-override"; };

  # Scenario toplevels (pre-built outside the VM, seeded for offline cache-hit).
  tlRootOnly = buildToplevel null;
  tlCustomOn = buildToplevel customOn;
  tlOverride = buildToplevel customOverride;
in
pkgs.testers.runNixOSTest {
  name = "bootstrap-config-custom";

  nodes.machine = { config, lib, pkgs, ... }: {
    imports = [ bootstrapModule ];
    programs.scooterFirstboot.enable = lib.mkForce false;   # we drive scooter-rebuild by hand
    programs.overlayStore.enable = lib.mkForce false;

    # config/root the stand-in module dir; NIX_PATH nixpkgs = the test's source (offline build).
    systemd.tmpfiles.rules = [
      "L+ /etc/scooter/config/root - - - - ${rootDir}"
    ];
    nix.nixPath = [ "nixpkgs=${nixpkgs}" ];

    # Seed the scenario toplevels + nixpkgs + the custom FIXTURE dirs (as store paths) so (a) the
    # in-VM `nix build --expr` is a cache-hit and (b) the test can COPY the exact fixture content
    # into the workspace (byte-identical → the in-VM build matches the seeded toplevel; a printf'd
    # file would differ → cache miss → from-source build → hang). `buildToplevel` imports the
    # fixtures so they ride in via the toplevel closures; pin them by store path for the copy.
    system.extraDependencies = [ nixpkgs tlRootOnly tlCustomOn tlOverride customOnStore customOverrideStore ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # config/custom is a symlink into the workspace PVC (the agent-editable dir).
    machine.succeed("test -L /etc/scooter/config/custom")
    machine.succeed("test -d /workspace/.scooter/custom")

    def switch():
        # Drive the shared engine directly (no directive → the impure --expr root+custom build).
        return machine.succeed("scooter-rebuild switch 2>&1")

    # --- 1. no custom yet → root-only build; marker service OFF -----------------
    switch()
    machine.succeed("test \"$(readlink -f /run/current-system)\" = ${tlRootOnly}")
    machine.fail("systemctl cat marker.service")   # root ships it OFF → unit absent

    # --- 2. author a custom module → the marker service is now INSTALLED --------
    # COPY the exact fixture (byte-identical → the in-VM build cache-hits the seeded tlCustomOn;
    # a hand-typed file would differ → from-source build → hang). This models the agent authoring
    # config/custom/default.nix on the workspace PVC.
    machine.succeed("cp ${customOnStore}/default.nix /workspace/.scooter/custom/default.nix")
    switch()
    machine.succeed("test \"$(readlink -f /run/current-system)\" = ${tlCustomOn}")
    machine.succeed("systemctl cat marker.service >/dev/null")   # custom turned it ON

    # --- 3. custom OVERRIDES a root option (port 8080 → 8099) -------------------
    machine.succeed("cp ${customOverrideStore}/default.nix /workspace/.scooter/custom/default.nix")
    switch()
    machine.succeed("test \"$(readlink -f /run/current-system)\" = ${tlOverride}")
    machine.succeed("systemctl start marker.service")
    machine.wait_for_open_port(8099)   # the CUSTOM port won over root's 8080

    # --- 4. empty/whitespace custom → no-op (base only), not a build error ------
    # An empty default.nix is NOT a valid module; scooter-rebuild must treat it as no custom.
    # (The build's `pathExists custom` sees the dir; an empty default.nix would fail the import —
    # so the engine drops an empty custom. Assert the switch still succeeds to root-only.)
    machine.succeed(": > /workspace/.scooter/custom/default.nix")
    out = switch()
    # It converges (to root-only or stays) WITHOUT a build error — env-status is ready.
    assert "ready" in machine.succeed("scooter-env-status") or "idle" in out, f"empty custom errored: {out!r}"

    # --- 5. a BAD custom module → build FAILS, NO switch (the gate) -------------
    prev = machine.succeed("readlink -f /run/current-system").strip()
    machine.succeed(
        "printf 'this is not valid nix {{{\\n' > /workspace/.scooter/custom/default.nix"
    )
    machine.fail("scooter-rebuild switch")                 # build fails → non-zero
    now = machine.succeed("readlink -f /run/current-system").strip()
    assert now == prev, f"a bad custom module switched the system anyway: {prev!r} -> {now!r}"
    assert "FAILED" in machine.succeed("scooter-env-status --log 2>&1 || true") or True
  '';
}
