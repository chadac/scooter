# Layers the enabled contribs' sandbox modules into the sandbox config.
#
# The list is computed FROM THE SOURCE (../../contrib), not handed in: `imports` is
# resolved before any option is read, so it could not come from a module argument
# anyway — and deriving it means the in-pod re-converge, which evaluates this same
# file out of the vendored tree, reaches the same answer with nothing carried across
# the switch. Why: PR #607.
{ lib, ... }:

let
  modules = import ../../contrib/sandbox-modules.nix { inherit lib; };
in
{
  imports = modules;

  # Which contrib modules this system was built with. The first thing to read in a
  # pod when a contrib's tools are missing — and the marker dev-env-contrib-sandbox
  # asserts on, since it is present only if this file is actually imported.
  environment.etc."scooter/contrib-modules".text =
    lib.concatMapStrings (m: "${toString m}\n") modules;
}
