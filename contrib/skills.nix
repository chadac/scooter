# The enabled contribs' SKILLS, derived from this source tree alone.
#
# `lib`-only, like contrib/sandbox-modules.nix: the consumer (modules/platform.nix)
# is a kubenix module an external deployer imports with no `pkgs` to build a
# contrib's service half with, and a skill needs none — it is a file read. A contrib
# forcing a service-side arg here is an eval error. Why: PR #618.
#
# Keyed by contrib NAME, not flattened to file->path, because the name IS the gate:
# platform.nix ships a contrib's skills only where broker.<name>.enable is true.
{ lib, extraModules ? [ ] }:

let
  eval = lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };
in
lib.mapAttrs (_: c: c.skills)
  (lib.filterAttrs (_: c: c.enable && c.skills != { }) eval.config.contribs)
