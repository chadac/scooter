# The enabled contribs' DEPLOYMENT modules — kubenix modules layered into
# modules/platform.nix, where each contrib declares its own options and renders
# its own manifests.
#
# `lib`-only, like contrib/sandbox-modules.nix (#607) and contrib/skills.nix (#618),
# and for the same reason: the consumer is a kubenix module an external deployer
# imports with no `pkgs`, so nothing here may force a built package. A contrib whose
# deployment module wants one is an eval error, and none does — a manifest is
# strings and attrsets.
#
# Which contribs are enabled is a property of THIS SOURCE TREE, so a deployment
# gets exactly the option trees for the contribs its image ships. An option that
# does not exist is an eval error, which is the loud failure you want when a
# manifest configures an integration that was never built in. Why: #599.
#
# `extraModules` is for a TEST that needs a contrib the repo does not ship enabled
# (same escape hatch as sandbox-modules.nix).
{ lib, extraModules ? [ ] }:

let
  # A second module system, so the kubenix-side `imports` gets plain paths rather
  # than config values it cannot read that early (see #615).
  eval = lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };

  # A disabled contrib is dropped here, so `enable = false` means its options do
  # not exist at all — no `mkIf` in any contrib's module.
  enabled = lib.filterAttrs
    (_: c: c.enable && c.deployment.module != null)
    eval.config.contribs;
in
lib.mapAttrsToList (_: c: c.deployment.module) enabled
