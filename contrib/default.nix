{ lib, writeText, runCommand, python3Packages, broker, webhooks, scooterBrokerLib, scooterWebhooksLib, ... }:

# Contrib registry: evaluates all-modules.nix and buckets it by service.
#
#   contribs = pkgs.callPackage ./contrib { inherit broker webhooks; ... };
#   broker   = pkgs.callPackage ./services/broker { contribs = contribs.broker; ... };
#
# A contrib build-depends on the extension surface libs, never on the
# broker/webhooks apps — that would be a build cycle. They are CHECK-only inputs
# so a contrib's tests can drive the real services. Why: PR #567.

let
  mkUiManifest = import ./ui-manifest.nix { inherit lib writeText runCommand; };

  evalWith = extraModules: lib.evalModules {
    specialArgs = {
      inherit lib python3Packages broker webhooks scooterBrokerLib scooterWebhooksLib;
    };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };

  mkOutputs = eval:
    let
      # Dropped before anything can reference a package, so a disabled contrib
      # never reaches a derivation.
      contribs = lib.filterAttrs (_: c: c.enable) eval.config.contribs;

      enabledServices = c: lib.filterAttrs (_: s: s.enable) c.services;

      forService = svc: lib.mapAttrsToList (_: c: c.services.${svc}.package)
        (lib.filterAttrs (_: c: c.services.${svc}.enable) contribs);

      # Keyed <name>-<service>: both variants share a derivation name, so a
      # name-keyed consumer (linkFarm) would collapse them. Why: PR #573.
      everyVariant = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
        (name: c: lib.mapAttrsToList
          (svc: s: lib.nameValuePair "${name}-${svc}" s.package)
          (enabledServices c))
        contribs));

      byName = lib.mapAttrs (_: c: lib.mapAttrs (_: s: s.package) (enabledServices c)) contribs;
    in
    {
      broker = forService "broker";
      webhooks = forService "webhooks";
      all = everyVariant;

      # The UI half: a source overlay compiled into the frontend bundle rather
      # than injected into an image. Not per-service, so it sits beside the
      # buckets.
      uiManifest = mkUiManifest contribs;
      packages = byName;
      inherit eval;
    };
in
mkOutputs (evalWith [ ]) // {
  # Same tree with extra modules layered on. CI uses it to build the contribs
  # that ship nowhere.
  withModules = extraModules: mkOutputs (evalWith extraModules);
}
