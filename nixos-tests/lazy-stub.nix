# nixosTest: a lazy tool stub resolves, execs the real tool, and memoizes.
#
# The core of the "light base image" requirement: `uv` is a PATH stub that
# builds the real package from the pinned nixpkgs on first call, caches the
# resolved store path, and execs it. Second call hits the cache (no re-resolve).
#
# Hermetic: the VM has no network, so we pin the stub's nixpkgs to the test's
# OWN pkgs (a local flake) and pre-seed the store with `uv`, so `nix build`
# resolves offline. This tests the STUB MECHANISM (resolve → memoize → exec),
# not network fetching (that's covered implicitly + by Tier 2).
#
# RED until Stage 5 implements stub generation in lazy-tools.nix.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-lazy-stub";

  nodes.machine = { config, pkgs, ... }: {
    imports = [ sandboxModule ];

    # Make `uv` resolvable offline: put it in the store closure so a `nix build`
    # of the pinned ref finds it without network. (Stage 5 decides the exact
    # offline-resolution shape; the test asserts the OBSERVABLE behavior.)
    system.extraDependencies = [ pkgs.uv ];

    # A tiny marker so we can detect a re-resolve vs a cache hit (Stage 5 wires
    # the stub to honor the cache; here we just assert cache-file behavior).
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # The stub is on PATH (not the real uv baked in — it's the lazy stub).
    machine.succeed("command -v uv")

    # First call: resolves + builds + execs the real uv. Slow-once is fine.
    out = machine.succeed("uv --version")
    assert "uv" in out, f"uv --version didn't run the real tool: {out!r}"

    # The resolved store path was memoized to the cache dir.
    machine.succeed("test -e /var/cache/lazy-tools/uv")

    # Second call still works (cache hit) and runs the same tool.
    machine.succeed("uv --version")
  '';
}
