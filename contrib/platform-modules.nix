# The enabled contribs, as kubenix modules for modules/platform.nix to import:
#
#   <name>/contrib.nix      its declaration — the same file the build and the sandbox
#                           image read, so the platform sees one registry, not a copy.
#                           `config.contribs.<name>.skills` resolves against this.
#   <name>/deployment.nix   its deployment half, if it has one: the `scooter.*`
#                           options an operator sets and the manifests they render.
#
# A separate `evalModules`, like contrib/sandbox-modules.nix and for the same reason:
# the platform's `imports` needs plain paths, and `imports` resolves before any option
# in its own eval exists — reading `config.contribs` there is `infinite recursion
# encountered`, which `tryEval` does not catch (#615).
#
# `lib`-only, like every other consumer of the registry: an external deployer imports
# modules/platform.nix with no `pkgs`. Free now that the schema itself is lib-only.
#
# A DISABLED contrib is dropped here, so its options do not exist and a manifest
# configuring it is an eval error rather than a silently ignored block. Why: #599.
#
# deployment.nix is found beside the declaration rather than declared, so adding an
# integration edits no platform file. check-contrib-coverage.sh fails CI on a stray
# .nix in a contrib directory — the typo this convention would otherwise swallow.
{ lib, extraModules ? [ ] }:

let
  eval = lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };

  # `src` IS the contrib's directory — it is what the build copies and what every
  # half sits in. Checked rather than assumed: a contrib that pointed `src` somewhere
  # else would otherwise lose its deployment half silently, which is the one failure
  # this file can produce.
  dirOf = name: c:
    if builtins.pathExists (c.src + "/contrib.nix") then c.src
    else throw ("contrib ${name}: `src` must be the directory holding its "
      + "contrib.nix — modules/platform.nix finds its deployment.nix beside it.");

  modulesOf = name: c:
    let dir = dirOf name c; in
    [ (dir + "/contrib.nix") ]
    ++ lib.optional (builtins.pathExists (dir + "/deployment.nix")) (dir + "/deployment.nix");
in
lib.concatLists (lib.mapAttrsToList modulesOf
  (lib.filterAttrs (_: c: c.enable) eval.config.contribs))
