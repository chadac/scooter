# The enabled contribs' SANDBOX modules, derived from this source tree alone.
#
# Evaluated twice from two different copies of the repo: once at image build, and
# once IN THE POD, where the re-converge rebuilds from the vendored tree (#614).
# `lib` is the ONLY argument either side gets — the service-side args that
# contrib/default.nix passes (broker, webhooks, python3Packages, the surface libs)
# are built packages, which the pod has no flake and no network to produce. A
# sandbox half that forces one is an eval error; nothing forces one today. Why: #607.
#
# `extraModules` is for a TEST that needs a contrib the repo does not ship enabled
# (see the dev-env-contrib-sandbox check). The image itself passes none: which
# contribs are enabled is a property of the source, which is exactly what lets both
# sides agree without anything being threaded through. Why: PR #607.
{ lib, extraModules ? [ ] }:

let
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
