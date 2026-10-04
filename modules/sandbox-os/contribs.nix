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
  #
  # baseNameOf, NOT toString. `toString` on a flake-relative PATH copies that
  # path's whole source tree into the store and yields the resulting /nix/store
  # reference -- so this marker file dragged the entire repo, .github included,
  # into the sandbox image's closure.
  #
  # The effect was not subtle: image content tags come from the image's store
  # hash, so editing a CI workflow comment changed every image tag, which busts
  # the k3d registry cache and forces a full re-push on a run where nothing about
  # the product moved. It is also the source of nix flake check's long-standing
  # "references the store path ... without a proper context" warning.
  #
  # The marker only needs to identify WHICH contribs are layered in -- the check
  # that reads it (dev-env-contrib-sandbox) asserts presence, not paths -- and a
  # base name does that without materialising anything.
  environment.etc."scooter/contrib-modules".text =
    lib.concatMapStrings (m: "${baseNameOf m}\n") modules;
}
