{ lib, python3Packages, broker, webhooks, scooterBrokerLib, scooterWebhooksLib, ... }:

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
# exercise the real services end-to-end (the app's own routes, its settings), not
# just the registries a contrib now depends on directly.

let
  entries = builtins.readDir ./.;
  contribNames = lib.filter
    (name: entries.${name} == "directory" && builtins.pathExists (./. + "/${name}/module.nix"))
    (lib.attrNames entries);

  # Built ONCE PER TARGET SERVICE, each variant depending only on that service's
  # surface. One build carrying both would drag scooter_webhooks_lib (and
  # sqlalchemy/asyncpg/aiosqlite) into the broker image. Why: PR #567.
  buildContrib = dir: svc:
    let
      meta = import (./. + "/${dir}/module.nix");
      pyImport = "scooter_contrib_${meta.name}";
      extraDeps = (meta.pythonDeps or (_: [ ])) python3Packages;
      # The surface for THIS service, and the module that composes it.
      surface = { broker = scooterBrokerLib; webhooks = scooterWebhooksLib; }.${svc};
      entryModule = { broker = "broker_provider"; webhooks = "webhooks_handler"; }.${svc};
    in
    python3Packages.buildPythonPackage {
      # Must stay the DISTRIBUTION name: the metadata-check hook looks the wheel
      # up by it. Variants differ by inputs, not pname.
      pname = "scooter-contrib-${meta.name}";
      version = "0.0.0";
      src = ./. + "/${dir}";
      pyproject = true;

      # Contribs standardize on the hatchling backend (declared in each
      # contrib's [build-system]); passed here because nixpkgs needs the
      # backend as an explicit build input.
      build-system = [ python3Packages.hatchling ];

      dependencies = [ python3Packages.fastapi surface ] ++ extraDeps;

      # Checked in the environment it will actually live in, so a bad import
      # fails this build instead of vanishing at service startup.
      pythonImportsCheck = [ pyImport "${pyImport}.${entryModule}" ];

      # Check-only, so they do NOT enter the runtime closure: the full
      # cross-service suite runs in both variants, neither ships the other.
      nativeCheckInputs = with python3Packages; [
        pytestCheckHook
        pytest-asyncio
        broker
        webhooks
      ];

      meta.description = "Scooter contrib module: ${meta.name} (${svc})";
    };

  metaOf = dir: import (./. + "/${dir}/module.nix");

  targets = svc: dir: lib.elem svc (metaOf dir).services;
  isExample = dir: (metaOf dir).example or false;

  # What actually ships into a service image. `example = true` contribs are
  # excluded: they are reference material, still built and tested via
  # packages.<name>.<svc>, but an example whose provider is unconditionally
  # enabled must not mount its routes on a production service.
  forService = svc:
    map (dir: buildContrib dir svc)
      (lib.filter (dir: targets svc dir && !isExample dir) contribNames);

  everyVariant = svc: map (dir: buildContrib dir svc) (lib.filter (targets svc) contribNames);

  # packages.<name>.<service>. No flat packages.<name>: which surface a contrib
  # carries is part of its identity now.
  byName = lib.listToAttrs (map
    (dir:
      let m = metaOf dir; in
      {
        name = m.name;
        value = lib.listToAttrs (map
          (svc: { name = svc; value = buildContrib dir svc; })
          m.services);
      })
    contribNames);
in
{
  # Per-service lists the flake injects into each service build. Each entry
  # carries only that service's extension surface.
  broker = forService "broker";
  webhooks = forService "webhooks";
  # Every variant of every contrib INCLUDING examples, and lookup by
  # name+service (e.g. contribs.packages.echo.broker).
  all = everyVariant "broker" ++ everyVariant "webhooks";
  packages = byName;
}
