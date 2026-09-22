# Pure EVAL (no VM): the in-pod re-converge expression still EVALUATES — through the
# flake, in PURE mode — and instantiates its toplevel.
#
# This is a guard for dev-env-scooter-module, the VM test that actually proves a
# `scooter-rebuild switch` converges. That one is in HEAVY_TESTS (a ~1h toplevel
# build), so it runs only nightly, where nothing gates a merge: a pure-eval violation
# in base-config.nix broke it for ten-plus days and no PR could have told you (#609).
# The break was in the first 30 seconds — evaluation — so evaluation is what a PR can
# afford to check. This costs an eval + `nixpkgs-src`, and builds no system.
#
# It cannot replace the VM test: it proves the expression evaluates and instantiates,
# NOT that the built system switches. Keep both.

{ pkgs, lib, sandboxModule ? null }:

let
  reconverged = (import ./reconverged.nix { inherit pkgs lib; }).toplevel;
  # Force evaluation + instantiation of the whole toplevel, but do NOT build it:
  # discarding the context leaves the .drv path as plain text, so this check depends
  # on nothing it printed. Evaluating `drvPath` is the entire point.
  drv = builtins.unsafeDiscardStringContext reconverged.drvPath;
in
pkgs.runCommand "dev-env-reconverge-eval" { } ''
  echo "re-converged toplevel instantiates: ${drv}"
  # Named in the log so a hash change is visible in a PR's check output: it must
  # match what the pod builds in-pod, or the VM test loses its offline cache hit.
  mkdir -p $out
  printf '%s\n' "${drv}" > $out/toplevel.drv
''
