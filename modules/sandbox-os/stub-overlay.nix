# The nix-stubs overlay for a stub set — ONE definition, two callers that must
# produce an IDENTICAL overlay: the image build (flake.nix, at pkgs construction)
# and the in-pod re-converge (stub-set.nix, via nixpkgs.overlays). If the two
# diverge, a self-modify re-fattens the system with the real packages.
# Why the callers apply it differently: PR #502.

{ lockLib # nix-stubs' pure-Nix lib — the flake's `lib`, or the vendored nix/lock.nix
, flakeLock # the flake.lock that stubs.lock is synced to; mkOverlay asserts they agree
, nix-stubs # the PREBUILT binary — a callPackage here compiles Rust in-pod
, stubs ? ./stubs.nix
, lock ? ./stubs.lock
}:

lockLib.mkOverlay {
  stubs = p: import stubs { pkgs = p; };
  inherit lock flakeLock nix-stubs;
}
