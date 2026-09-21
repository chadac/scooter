{ lib, python3Packages, broker, webhooks, ... }:

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
# A contrib's package declares NO dependency on broker/webhooks (that would be a
# build cycle: a service depends on its contribs). Its service-coupled modules
# import the host service at RUNTIME, when the service loads the entry point.
# broker/webhooks are passed here only as CHECK inputs so a contrib's tests can
# exercise the real registries end-to-end.

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

        dependencies = [ python3Packages.fastapi ] ++ extraDeps;

        # Import-check only the neutral top-level module. The service-coupled
        # modules (broker_provider / webhooks_handler) import broker/webhooks,
        # which are absent from a contrib's own runtime deps — they resolve at
        # runtime in the host image, and are verified by the check phase below.
        pythonImportsCheck = [ pyImport ];

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
