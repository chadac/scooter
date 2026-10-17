# The enabled contribs' sandbox modules, evaluated once at image build and baked
# into the re-converge's module list so a self-modify replays the same modules
# by path. `modules` holds the real paths for the booted system's `imports`;
# `treeRelative` holds the same files relative to the repo root, resolved
# against the vendored tree (reconverge-inputs.nix) in the pod. `extraModules`
# lets a test enable a contrib the repo ships disabled.
{ lib, extraModules ? [ ] }:

let
  # A module system of its own, so the NixOS-side `imports` gets plain paths rather than config values it cannot read that early.
  eval = lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ] ++ extraModules;
  };

  # A disabled contrib is absent from the image with no `mkIf` in any contrib's module.
  enabled = lib.filterAttrs
    (_: c: c.enable && c.sandbox.module != null)
    eval.config.contribs;
in
{
  modules = lib.mapAttrsToList (_: c: c.sandbox.module) enabled;

  # The enabled contribs' skill directories: name -> { contrib; src; }.
  skillDirs = import ./skill-dirs.nix { inherit lib; contribs = eval.config.contribs; };

  # Built from base names rather than `toString`, which would drag the whole repo into the image closure, and checked against this tree so a path that resolves nowhere throws at image build.
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
