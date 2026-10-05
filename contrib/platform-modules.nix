# The shipped contribs, as kubenix modules for modules/platform.nix to import.
#
# Each one contributes two modules to the PLATFORM eval:
#
#   <name>/contrib.nix    its declaration — the same file the build and the sandbox
#                         image read, so the platform sees one registry, not a copy.
#                         This is what `config.contribs.<name>.skills` resolves
#                         against (platform.nix reads it directly; there is no
#                         second eval to re-derive it from).
#   <name>/platform.nix   its deployment half, if it has one: the `scooter.*`
#                         options an operator sets and the manifests they render,
#                         declared in the SAME eval as modules/platform.nix.
#
# No `evalModules` and no option read, which is the point: a contrib's deployment
# options reach the platform as plain module paths. Reading them out of a config
# value instead is `infinite recursion encountered` — `imports` is resolved before
# any option exists — and that recursion is what the old `deployment.module` +
# contrib/deployment-modules.nix pair existed to route around. Why: #711, #615.
#
# SHIPPED, not "enabled": a contrib with `ship = false` is absent here, so its
# options DO NOT EXIST and a manifest configuring it is an eval error rather than a
# silently ignored block. Why: #599.
#
# `platform.nix` is found by convention rather than declared, so adding an
# integration still edits no platform file (#599). check-contrib-coverage.sh fails
# CI on a stray .nix in a contrib directory — the typo this would otherwise swallow.
let
  contribs = import ./contribs.nix;

  modulesOf = c:
    [ (c.dir + "/contrib.nix") ]
    ++ (if builtins.pathExists (c.dir + "/platform.nix")
    then [ (c.dir + "/platform.nix") ]
    else [ ]);
in
builtins.concatLists
  (map modulesOf
    (builtins.filter (c: c.ship) (builtins.attrValues contribs)))
