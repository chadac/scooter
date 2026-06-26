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

  nodes.machine = { config, pkgs, lib, ... }: {
    imports = [ sandboxModule ];

    # Resolve OFFLINE: point the stub's default nixpkgs at the test's own nixpkgs
    # SOURCE as a path-flake, and pre-seed both that source and the built `uv`
    # into the VM store. Then `nix build path:<src>#uv` evaluates from the store
    # (no fetch) and the output is already realised (no build) — fully offline.
    # In production this is a `github:NixOS/nixpkgs/<rev>` ref over the network;
    # the stub CODE PATH is identical, only the ref differs.
    programs.lazyTools.defaultNixpkgs = lib.mkForce "path:${pkgs.path}";
    system.extraDependencies = [ pkgs.uv pkgs.path ];

    # Flakes + a writable store so `nix build` works in-VM.
    nix.settings.experimental-features = [ "nix-command" "flakes" ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # The stub on PATH is OUR lazy stub, not the real uv baked in — the base
    # image ships no uv closure; it materializes on first call.
    uv_path = machine.succeed("command -v uv").strip()
    assert "lazy-tools" not in uv_path  # sanity: it's the stub wrapper, resolved lazily

    # First call: resolves + execs the real uv. Slow-once is fine.
    out = machine.succeed("uv --version")
    assert "uv" in out, f"uv --version didn't run the real tool: {out!r}"

    # The resolved store path was memoized to the cache dir, tagged with the ref.
    machine.succeed("test -e /var/cache/lazy-tools/uv")
    cache = machine.succeed("cat /var/cache/lazy-tools/uv")
    cached_ref, cached_path = cache.splitlines()[0], cache.splitlines()[1]
    assert cached_ref.startswith("path:"), f"cache ref not the pinned ref: {cached_ref!r}"
    machine.succeed(f"test -x {cached_path}")  # the memoized binary exists + is runnable

    # CACHE HIT (proves "slow only once"): stop the nix daemon so a RE-RESOLVE
    # (`nix build`) would FAIL, then call again. If it still works, the stub
    # served the tool from its memoized cache without touching nix.
    machine.succeed("systemctl stop nix-daemon.socket nix-daemon.service")
    machine.succeed("uv --version")  # must be served from cache — no daemon to resolve

    # The cache file is unchanged (no re-write -> no re-resolve happened).
    cache2 = machine.succeed("cat /var/cache/lazy-tools/uv")
    assert cache2 == cache, "cache changed on the second call (unexpected re-resolve)"
  '';
}
