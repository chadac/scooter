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

  # The ONLY observable this file has when no contrib is enabled, and what
  # dev-env-contrib-sandbox asserts on: the check injects echo through `extraModules`,
  # so without this marker it stays green with contribs.nix imported by nobody.
  environment.etc."scooter/contrib-modules".text =
    lib.concatMapStrings (m: "${toString m}\n") modules;
}
