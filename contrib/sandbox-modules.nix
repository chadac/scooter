# The enabled contribs' SANDBOX modules, for the image build.
#
# Evaluated ONCE, at image build — not in the pod. The sandbox image bakes this list
# into the re-converge's module list file (programs.scooterModule.
# extraReconvergeModuleFiles), so a self-modify replays the same modules by path
# instead of re-evaluating the contrib registry with no flake and no network. Why:
# PR #717, and modules/sandbox-os/runtime-converge.nix.
#
# Two views of the same set, because the two sides of the image need different shapes:
#
#   modules      the real paths, for the booted system's `imports`.
#   treeRelative the same files as paths RELATIVE TO THE REPO ROOT, for the baked
#                list — the re-converge resolves them against the vendored tree
#                (reconverge-inputs.nix), which is the copy the pod actually has.
#
# treeRelative is built from the convention (`contrib/<name>/<file>`) rather than by
# stringifying the paths: `toString` on a repo path yields a store reference to the
# WHOLE source tree, and anything that lands in the image from such a string drags
# the repo into the sandbox closure and re-tags every image when any file moves (the
# regression the old /etc/scooter/contrib-modules marker was fixed for).
#
# `extraModules` is for a TEST that needs a contrib the repo ships disabled (see the
# dev-env-contrib-sandbox check). The image itself passes none: which contribs are
# enabled is a property of the source. Why: PR #607.
{ lib, extraModules ? [ ] }:

let
  # A module system of its own, so the NixOS-side `imports` gets plain paths rather
  # than config values it cannot read that early (#615). The platform no longer needs
  # this shape — its imports are static and `enable` gates rendering instead (#719) —
  # but the image genuinely cannot import a disabled contrib's sandbox module: there
  # is no `enable` in the POD's eval to gate it with, and the re-converge replays this
  # list by path with no registry at all.
  eval = lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };

  # A disabled contrib is dropped here, so `enable = false` means absent from the
  # image with no `mkIf` in any contrib's module.
  enabled = lib.filterAttrs
    (_: c: c.enable && c.sandbox.module != null)
    eval.config.contribs;
in
{
  modules = lib.mapAttrsToList (_: c: c.sandbox.module) enabled;

  # `contrib/<dir>/<file>`, from the contrib's own `src` and module paths — base
  # names only, never `toString`. CHECKED against this tree rather than trusted: a
  # relative path that resolves nowhere would import nothing in the pod (a sandbox
  # silently missing a contrib's tools after the first self-modify), so it throws at
  # image build instead.
  treeRelative = lib.mapAttrsToList
    (name: c:
      let rel = "contrib/${baseNameOf c.src}/${baseNameOf c.sandbox.module}"; in
      if (./.. + "/${rel}") == c.sandbox.module then rel
      else throw ("contrib ${name}: its sandbox module must be the sandbox.nix in "
        + "its own directory. ${rel} is where the re-converge would look in the "
        + "vendored tree, and that is not the file this contrib declared — the "
        + "booted image and every self-modify after it would import different "
        + "modules."))
    enabled;
}
