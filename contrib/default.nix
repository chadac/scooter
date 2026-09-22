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
  # python3Packages PLUS every contrib built for this service, which is what a
  # module's `pythonDeps = service: ps: ...` receives. So one field expresses both
  # "a library from nixpkgs" and "another contrib", per service.
  #
  # Contribs are prefixed `scooterContrib<Name>`: a bare `ps.jira` would shadow
  # nixpkgs' own python3Packages.jira (the Jira API client), and a dep silently
  # resolving to the wrong package is worse than a longer name.
  #
  # Lazy (an attrset of thunks), so naming one contrib does not build the rest, and
  # a dependency CYCLE surfaces as infinite recursion at eval rather than a
  # half-working image.
  contribAttrName = name:
    "scooterContrib" + lib.toUpper (lib.substring 0 1 name) + lib.substring 1 (-1) name;

  pkgsFor = svc: python3Packages // lib.listToAttrs (map
    (dir: { name = contribAttrName (metaOf dir).name; value = buildContrib dir svc; })
    contribNames);

  buildContrib = dir: svc:
    let
      meta = import (./. + "/${dir}/module.nix");
      pyImport = "scooter_contrib_${meta.name}";
      # `service: ps: [ ... ]`. The service argument is what lets a contrib depend on
      # something for one half and not the other -- gitlab needs jira only in the
      # webhooks variant, and a flat list would drag it into the broker closure too,
      # the surface leak the per-service split exists to stop (#567). Why: PR #583.
      depsFor = s: (meta.pythonDeps or (_: _: [ ])) s (pkgsFor svc);
      extraDeps = depsFor svc;
      # Every service's deps, resolved for THIS variant, for the CHECK phase only:
      # tests/ is shared across variants, so a webhooks-only test still has to
      # import in the broker variant -- the same reason the real services are check
      # inputs. Check-only, so it does not widen the runtime closure.
      checkDeps = lib.concatMap depsFor meta.services;
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
      nativeCheckInputs = (with python3Packages; [
        pytestCheckHook
        pytest-asyncio
        broker
        webhooks
      ]) ++ checkDeps;

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

  # Keyed `<name>-<service>`, NOT a list: both variants of a two-service contrib
  # share a derivation name, so a name-keyed consumer (linkFarm) collapses them
  # and silently drops one. Why: PR #573.
  everyVariant = lib.listToAttrs (lib.concatMap
    (svc: map
      (dir: { name = "${(metaOf dir).name}-${svc}"; value = buildContrib dir svc; })
      (lib.filter (targets svc) contribNames))
    [ "broker" "webhooks" ]);

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
  # Every variant of every contrib INCLUDING examples, keyed <name>-<service>,
  # plus lookup by name+service (e.g. contribs.packages.echo.broker).
  all = everyVariant;
  packages = byName;
}
