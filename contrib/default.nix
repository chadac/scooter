{ lib, writeText, python3Packages, broker, webhooks, scooterBrokerLib, scooterWebhooksLib
, deploymentModules ? [ ]
, ... }:

# Contrib registry: evaluates all-modules.nix, builds it, and buckets it by service.
#
#   contribs = pkgs.callPackage ./contrib { inherit broker webhooks; ... };
#   broker   = pkgs.callPackage ./services/broker { contribs = contribs.broker; ... };
#
# The EVAL is lib-only (contrib/spec.nix) and shared with the sandbox image and the
# kubenix platform; the BUILD is contrib/build.nix, applied here because this is the
# only one of the three consumers that has a `pkgs`. Why: #711.

let
  mkUiManifest = import ./ui-manifest.nix { inherit lib writeText; };
  mkPackages = import ./build.nix {
    inherit lib python3Packages broker webhooks scooterBrokerLib scooterWebhooksLib;
  };

  # deploymentModules says which contribs to ship. Passed IN -- this tree is
  # vended, so it names no deployment of its own.
  evalWith = extraModules: lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ] ++ deploymentModules ++ extraModules;
  };

  mkOutputs = eval:
    let
      # Dropped before anything can reference a package, so a contrib that ships
      # nowhere never reaches a derivation.
      contribs = lib.filterAttrs (_: c: c.enable) eval.config.contribs;

      # name -> service -> derivation.
      byName = mkPackages contribs;

      forService = svc: lib.mapAttrsToList (_: variants: variants.${svc})
        (lib.filterAttrs (_: variants: variants ? ${svc}) byName);

      # Keyed <name>-<service>: both variants share a derivation name, so a
      # name-keyed consumer (linkFarm) would collapse them. Why: PR #573.
      everyVariant = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
        (name: variants: lib.mapAttrsToList
          (svc: drv: lib.nameValuePair "${name}-${svc}" drv)
          variants)
        byName));
    in
    {
      broker = forService "broker";
      webhooks = forService "webhooks";
      all = everyVariant;

      # The UI half: metadata only, compiled into the frontend bundle rather than
      # injected into an image. Not per-service, so it sits beside the buckets.
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
