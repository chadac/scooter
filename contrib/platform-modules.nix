# The enabled contribs, as kubenix modules for modules/platform.nix to import.
#
# Each one contributes two modules to the PLATFORM eval:
#
#   <name>/contrib.nix    its declaration — the same file the build and the sandbox
#                         image read, so the platform sees one registry, not a copy.
#                         This is what `config.contribs.<name>.skills` resolves
#                         against; platform.nix reads it directly, with no second
#                         derivation that could disagree.
#   <name>/platform.nix   its deployment half, if it has one: the `scooter.*`
#                         options an operator sets and the manifests they render,
#                         declared in the SAME eval as modules/platform.nix.
#
# A separate `evalModules`, exactly like contrib/sandbox-modules.nix (#607) and for
# the same reason: the platform's `imports` needs plain paths, and `imports` is
# resolved before any option in ITS OWN eval exists — reading `config.contribs` there
# is `infinite recursion encountered`, and not catchable (#615). A second eval is how
# you answer "which contribs are enabled" without reading an option you cannot reach.
#
# `lib`-only, like every other consumer of the registry: an external deployer imports
# platform.nix with no `pkgs`, and a manifest needs none. Free now that the schema
# itself is lib-only. Why: #711.
#
# ENABLED, not merely present: a disabled contrib is dropped here, so its options DO
# NOT EXIST and a manifest configuring it is an eval error rather than a silently
# ignored block. Why: #599.
#
# `platform.nix` is found beside the declaration rather than declared, so adding an
# integration still edits no platform file (#599) and there is no `deployment.module`
# indirection left to resolve. check-contrib-coverage.sh fails CI on a stray .nix in
# a contrib directory — the typo this would otherwise swallow.
{ lib, extraModules ? [ ] }:

let
  eval = lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };

  # `src` IS the contrib's directory — it is what the build copies and what every
  # half sits in. Checked rather than assumed: a contrib that pointed `src` somewhere
  # else would otherwise lose its platform half silently, which is the one failure
  # this file can produce.
  dirOf = name: c:
    if builtins.pathExists (c.src + "/contrib.nix") then c.src
    else throw ("contrib ${name}: `src` must be the directory holding its "
      + "contrib.nix — modules/platform.nix finds its platform.nix beside it.");

  modulesOf = name: c:
    let dir = dirOf name c; in
    [ (dir + "/contrib.nix") ]
    ++ lib.optional (builtins.pathExists (dir + "/platform.nix")) (dir + "/platform.nix");
in
lib.concatLists (lib.mapAttrsToList modulesOf
  (lib.filterAttrs (_: c: c.enable) eval.config.contribs))
