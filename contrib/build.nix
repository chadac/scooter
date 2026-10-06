# The contribs' BUILD half: one Python package per (contrib, service).
#
# Plain Nix over the evaluated spec rather than a `package` option inside
# contrib/submodule.nix, and that is the whole point of #711: an option would make
# the schema take `python3Packages` and the surface libs as module args, which the
# kubenix eval and the in-pod re-converge have no way to supply. The schema stays
# lib-only (contrib/spec.nix); everything that needs a derivation is here, called
# only from contrib/default.nix where `pkgs` exists.
#
# A contrib build-depends on the extension surface libs, never on the
# broker/webhooks apps — that would be a build cycle. They are CHECK-only inputs
# so a contrib's tests can drive the real services. Why: PR #567.
{ lib, python3Packages, broker, webhooks, scooterBrokerLib, scooterWebhooksLib }:

# contribs: the ENABLED contribs, name -> evaluated spec.
contribs:

let
  # Built once per service against only that service's surface: one build carrying
  # both drags scooter_webhooks_lib into the broker image. Why: PR #567.
  surfaces = {
    broker = { surface = scooterBrokerLib; entryModule = "broker_provider"; };
    webhooks = { surface = scooterWebhooksLib; entryModule = "webhooks_handler"; };
  };

  enabledServices = c: lib.filterAttrs (_: s: s.enable) c.services;

  # What pythonDeps receives. Nested so contribs cannot shadow nixpkgs
  # (python3Packages.jira is the Jira client), and holds only contribs targeting
  # this service, so naming one that does not is an error.
  pkgsFor = svc: python3Packages // {
    scooterContrib = lib.mapAttrs (_: variants: variants.${svc})
      (lib.filterAttrs (_: variants: variants ? ${svc}) packages);
  };

  # tests/ is shared across variants, so every service's deps are check inputs for
  # each one. Check-only, so the runtime closure stays per-service.
  checkDepsFor = c: svc: lib.concatMap (s: s.pythonDeps (pkgsFor svc))
    (lib.attrValues (enabledServices c));

  buildFor = name: c: svc:
    let s = surfaces.${svc}; in
    python3Packages.buildPythonPackage {
      # Must stay the distribution name: the metadata-check hook looks the wheel up
      # by it. Variants differ by inputs, not pname.
      pname = c.distName;
      inherit (c) version src;
      pyproject = true;
      build-system = [ python3Packages.hatchling ];

      dependencies = [ python3Packages.fastapi s.surface ]
        ++ c.services.${svc}.pythonDeps (pkgsFor svc);

      # Checked in the environment it will live in, so a bad import fails here
      # rather than at service startup.
      pythonImportsCheck = [ c.pyModule "${c.pyModule}.${s.entryModule}" ];

      nativeCheckInputs = (with python3Packages; [
        pytestCheckHook
        pytest-asyncio
        broker
        webhooks
      ]) ++ checkDepsFor c svc;

      meta.description = "Scooter contrib module: ${name} (${svc})";
    };

  # name -> service -> derivation. Self-referential through pkgsFor: a contrib may
  # depend on another contrib's build (ps.scooterContrib.<name>), which laziness
  # resolves as long as no two contribs depend on each other.
  packages = lib.mapAttrs
    (name: c: lib.mapAttrs (svc: _: buildFor name c svc) (enabledServices c))
    contribs;
in
packages
