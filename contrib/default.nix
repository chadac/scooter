{ lib, python3Packages, broker, webhooks, scooterBrokerLib, scooterWebhooksLib, ... }:

# Contrib registry: evaluates `all-modules.nix` and buckets the result by service
# so the flake can inject the right subset into each service image.
#
#   contribs = pkgs.callPackage ./contrib { inherit broker webhooks; ... };
#   broker   = pkgs.callPackage ./services/broker   { contribs = contribs.broker; ... };
#   webhooks = pkgs.callPackage ./services/webhooks { contribs = contribs.webhooks; ... };
#
# The schema and the build both live in the module system (contrib/options.nix +
# contrib/submodule.nix); this file only turns evaluated config into the outputs
# the flake consumes. Adding a field to the spec is an option with a default, so
# it no longer means editing every contrib. Why: PR #585.
#
# `enable = false` means ABSENT, NixOS-style: a disabled contrib produces no
# derivation at all, not a derivation that is filtered out later. To build one
# anyway -- CI has to build the reference contrib to test it -- layer a module on
# with `withModules` rather than weakening `enable`.
#
# A contrib build-depends on the EXTENSION SURFACE libs, never on the
# broker/webhooks apps (that would be a build cycle: a service depends on its
# contribs). The surface is a real build input, so a broken extension fails the
# contrib's own build instead of vanishing at service startup — which is the
# arrangement PR #567 exists to replace. broker/webhooks are still passed as
# CHECK-only inputs so a contrib's tests can exercise the real services.

let
  evalWith = extraModules: lib.evalModules {
    specialArgs = {
      inherit lib python3Packages broker webhooks scooterBrokerLib scooterWebhooksLib;
    };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };

  mkOutputs = eval:
    let
      # Disabled contribs are dropped HERE, before anything can reference a
      # package, so `enable = false` never reaches a derivation.
      contribs = lib.filterAttrs (_: c: c.enable) eval.config.contribs;

      # Services a contrib actually targets, as an attrset of the service submodules.
      enabledServices = c: lib.filterAttrs (_: s: s.enable) c.services;

      forService = svc: lib.mapAttrsToList (_: c: c.services.${svc}.package)
        (lib.filterAttrs (_: c: c.services.${svc}.enable) contribs);

      # Keyed `<name>-<service>`, NOT a list: both variants of a two-service contrib
      # share a derivation name, so a name-keyed consumer (linkFarm) collapses them
      # and silently drops one. Why: PR #573.
      everyVariant = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
        (name: c: lib.mapAttrsToList
          (svc: s: lib.nameValuePair "${name}-${svc}" s.package)
          (enabledServices c))
        contribs));

      # packages.<name>.<service>. No flat packages.<name>: which surface a contrib
      # carries is part of its identity.
      byName = lib.mapAttrs (_: c: lib.mapAttrs (_: s: s.package) (enabledServices c)) contribs;
    in
    {
      # Per-service lists the flake injects into each service build. Each entry
      # carries only that service's extension surface.
      broker = forService "broker";
      webhooks = forService "webhooks";
      # Every variant of every ENABLED contrib, keyed <name>-<service>, plus lookup
      # by name+service (e.g. contribs.packages.jira.broker).
      all = everyVariant;
      packages = byName;

      # The evaluated module tree, for anything that wants the config rather than
      # the packages (option docs, a future deploy-time consumer).
      inherit eval;
    };
in
mkOutputs (evalWith [ ]) // {
  # The same tree with extra modules layered on, returning the same outputs. This
  # is how a disabled contrib gets built without `enable` having to mean anything
  # softer than "absent": CI overrides it on.
  #
  #   contribs.withModules [{ contribs.echo.enable = true; }]
  withModules = extraModules: mkOutputs (evalWith extraModules);
}
