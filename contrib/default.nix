{ lib, python3Packages, broker, webhooks, scooterBrokerLib, ... }:

# Contrib module builder + registry.
#
# Each `contrib/<name>/` is a self-contained Python distribution that plugs into
# one or more Scooter services purely through entry points (no service-core
# edits). This file discovers every contrib, builds it, and buckets it by the
# service(s) its `module.nix` targets, so the flake can inject the right subset
# into each service image:
#
#   contribs = pkgs.callPackage ./contrib { inherit broker webhooks; ... };
#   broker   = pkgs.callPackage ./services/broker   { contribs = contribs.broker; ... };
#   webhooks = pkgs.callPackage ./services/webhooks { contribs = contribs.webhooks; ... };
#
# A contrib build-depends on the EXTENSION SURFACE libs, never on the
# broker/webhooks apps (that would be a build cycle: a service depends on its
# contribs). The surface is a real build input, so a broken extension fails the
# contrib's own build instead of vanishing at service startup — which is the
# arrangement PR #567 exists to replace.
#
# broker/webhooks are still passed as CHECK-only inputs so a contrib's tests can
# exercise the real registries end-to-end, and because the webhooks half of the
# surface has not moved yet.

let
  entries = builtins.readDir ./.;
  contribNames = lib.filter
    (name: entries.${name} == "directory" && builtins.pathExists (./. + "/${name}/module.nix"))
    (lib.attrNames entries);

  buildContrib = dir:
    let
      meta = import (./. + "/${dir}/module.nix");
      pyImport = "scooter_contrib_${meta.name}";
      extraDeps = (meta.pythonDeps or (_: [ ])) python3Packages;
      package = python3Packages.buildPythonPackage {
        pname = "scooter-contrib-${meta.name}";
        version = "0.0.0";
        src = ./. + "/${dir}";
        pyproject = true;

        # Contribs standardize on the hatchling backend (declared in each
        # contrib's [build-system]); passed here because nixpkgs needs the
        # backend as an explicit build input.
        build-system = [ python3Packages.hatchling ];

        dependencies = [ python3Packages.fastapi ]
          ++ lib.optional (lib.elem "broker" meta.services) scooterBrokerLib
          ++ extraDeps;

        # A broker contrib's provider module is import-checked directly: its only
        # non-stdlib imports are fastapi + the surface lib, both real deps now, so
        # a bad import is this build's failure. The webhooks half still imports
        # the app and resolves at runtime, so it stays out until that surface
        # moves; the check phase below covers it meanwhile.
        pythonImportsCheck = [ pyImport ]
          ++ lib.optional (lib.elem "broker" meta.services) "${pyImport}.broker_provider";

        # The contrib's tests run against the REAL broker + webhooks registries
        # (provided as check-only inputs), proving entry-point discovery works.
        nativeCheckInputs = with python3Packages; [
          pytestCheckHook
          pytest-asyncio
          broker
          webhooks
        ];

        meta.description = "Scooter contrib module: ${meta.name}";
      };
    in
    { inherit (meta) name services; inherit package; };

  built = map buildContrib contribNames;

  forService = svc: map (c: c.package) (lib.filter (c: lib.elem svc c.services) built);

  byName = lib.listToAttrs (map (c: { inherit (c) name; value = c.package; }) built);
in
{
  # Per-service lists the flake injects into each service build.
  broker = forService "broker";
  webhooks = forService "webhooks";
  # All contrib packages, and lookup by name (e.g. contribs.packages.echo).
  all = map (c: c.package) built;
  packages = byName;
}
