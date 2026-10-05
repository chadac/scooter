# The enabled contribs' SANDBOX modules, derived from this source tree alone.
#
# Evaluated twice from two different copies of the repo: once at image build, and
# once IN THE POD, where the re-converge rebuilds from the vendored tree (#614).
# `lib` is the ONLY argument either side gets, which is free now that the schema
# itself is lib-only (#711): the pod has no flake and no network, so anything that
# forced a derivation here would be an eval error there.
#
# Still an `evalModules`, unlike contrib/platform-modules.nix: `sandbox.module` is
# an option a contrib SETS, and `extraModules` below has to be able to override
# `enable` — neither is readable from contrib/contribs.nix alone.
#
# `extraModules` is for a TEST that needs a contrib the repo ships nowhere
# (see the dev-env-contrib-sandbox check). The image itself passes none: which
# contribs ship is a property of the source, which is exactly what lets both
# sides agree without anything being threaded through. Why: PR #607.
{ lib, extraModules ? [ ] }:

let
  # A second module system, so the NixOS-side `imports` gets plain paths rather than
  # config values it cannot read that early. Collapsing the two: #615.
  eval = lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };

  # A disabled contrib is dropped here, so `enable = false` means absent from the
  # image with no `mkIf` in any contrib's module.
  enabled = lib.filterAttrs
    (_: c: c.enable && c.sandbox.module != null)
    eval.config.contribs;
in
lib.mapAttrsToList (_: c: c.sandbox.module) enabled
