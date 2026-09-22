# The enabled contribs' SANDBOX modules, derived from this source tree alone.
#
# Evaluated twice from two different copies of the repo: once at image build, and
# once IN THE POD, where the re-converge rebuilds from the vendored tree (#614) and
# no service package exists. Hence the throwing stubs — a sandbox module that
# reaches for the broker or webhooks half is an error here, not a mystery failure
# during a `scooter-rebuild switch`. The contrib schema keeps those behind `services`,
# so nothing forces them today.
#
# `extraModules` is for a TEST that needs a contrib the repo does not ship enabled
# (see the dev-env-contrib-sandbox check). The image itself passes none: which
# contribs are enabled is a property of the source, which is exactly what lets both
# sides agree without anything being threaded through. Why: PR #607.
{ lib, extraModules ? [ ] }:

let
  needsService = name: throw
    "contrib/sandbox-modules.nix: the sandbox half must not need ${name} — it is evaluated in-pod, where the service packages do not exist";

  eval = lib.evalModules {
    specialArgs = {
      inherit lib;
      python3Packages = needsService "python3Packages";
      broker = needsService "broker";
      webhooks = needsService "webhooks";
      scooterBrokerLib = needsService "scooterBrokerLib";
      scooterWebhooksLib = needsService "scooterWebhooksLib";
    };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };

  # A disabled contrib is dropped here, so `enable = false` means absent from the
  # image with no `mkIf` in any contrib's module.
  enabled = lib.filterAttrs
    (_: c: c.enable && c.sandbox.module != null)
    eval.config.contribs;
in
lib.mapAttrsToList (_: c: c.sandbox.module) enabled
