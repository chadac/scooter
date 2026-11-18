# The enabled contribs' sandbox modules, evaluated once at image build and baked
# into the re-converge's module list so a self-modify replays the same modules
# by path. `modules` holds the real paths for the booted system's `imports`;
# `treeRelative` holds the same files relative to the vendored tree
# (reconverge-inputs.nix) the pod resolves them against. `extraModules`
# lets a test enable a contrib the repo ships disabled.
{ lib, extraModules ? [ ] }:

let
  # A module system of its own, so the NixOS-side `imports` gets plain paths rather than config values it cannot read that early.
  eval = lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ./all-modules.nix ../modules/skills ] ++ extraModules;
  };

  # A disabled contrib is absent from the image with no `mkIf` in any contrib's module.
  enabled = lib.filterAttrs
    (_: c: c.enable && c.sandbox.module != null)
    eval.config.contribs;

  # In-tree contribs are already in the vendored tree.
  inTree = c: toString c.src == toString (./.. + "/contrib/${baseNameOf c.src}");
in
{
  modules = lib.mapAttrsToList (_: c: c.sandbox.module) enabled;

  # Skill directories (modules/skills), the enabled contribs' included: name -> store path.
  skillDirs = eval.config.resolvedSkillDirs;

  # Vendored to contrib-ext/<name> by reconverge-inputs.nix.
  outOfTreeSrcs = lib.mapAttrs (_: c: c.src) (lib.filterAttrs (_: c: !inTree c) enabled);

  # Base names, not `toString`, keep the repo out of closures.
  treeRelative = lib.mapAttrsToList
    (name: c:
      let
        file = baseNameOf c.sandbox.module;
        rel = if inTree c then "contrib/${baseNameOf c.src}/${file}" else "contrib-ext/${name}/${file}";
        # Where the module must be for `rel` to match.
        expected = if inTree c then toString (./.. + "/${rel}") else "${toString c.src}/${file}";
      in
      if toString c.sandbox.module == expected then rel
      else throw ("contrib ${name}: its sandbox module must sit directly in its "
        + "`src` (${toString c.src}), and is ${toString c.sandbox.module}. The "
        + "re-converge imports ${rel} from the vendored tree, so the booted image "
        + "and every self-modify after it would import different modules."))
    enabled;
}
