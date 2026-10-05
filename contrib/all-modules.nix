# Every contrib's DECLARATION plus the schema, as one importable module.
#
# This is the registry as the lib-only evals see it: contrib/default.nix (the
# build), contrib/sandbox-modules.nix (the image, and its in-pod re-converge).
# modules/platform.nix does NOT import this — it imports the shipped contribs
# through contrib/platform-modules.nix, which also carries each one's platform
# half. Why: #711.
{ lib, ... }:

let
  contribs = import ./contribs.nix;
in
{
  imports = [ ./spec.nix ]
    ++ lib.mapAttrsToList (_: c: c.dir + "/contrib.nix") contribs;

  # Shippedness comes from the list, not from the contrib: the platform has to read
  # the same fact at `imports` time, where no option can be read. One definition,
  # two consumers. Why: #711 (and contrib/contribs.nix).
  config.contribs = lib.mapAttrs (_: c: { enable = c.ship; }) contribs;
}
