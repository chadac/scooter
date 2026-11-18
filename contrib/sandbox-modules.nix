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

  # Where `src` lands in the vendored tree.
  treeDir = name: c: if inTree c then "contrib/${baseNameOf c.src}" else "contrib-ext/${name}";

  hasStubs = c: builtins.pathExists (c.src + "/stubs.nix");

  # Stubs ship with a sandbox half; nothing else is vendored.
  stubsWithoutModule = lib.attrNames (lib.filterAttrs
    (_: c: c.enable && c.sandbox.module == null && hasStubs c)
    eval.config.contribs);

  withStubs = lib.filterAttrs (_: hasStubs) enabled;

  scooterFlakeLock = ../flake.lock;
in
assert stubsWithoutModule == [ ] || throw ("contribs ${toString stubsWithoutModule} have a "
  + "stubs.nix but no `sandbox.module`; a stub set ships with its contrib's sandbox half.");
assert !(withStubs ? base) || throw "contrib `base` can't have stubs: the name is the base stub set's.";
{
  modules = lib.mapAttrsToList (_: c: c.sandbox.module) enabled;

  # Skill directories (modules/skills), the enabled contribs' included: name -> store path.
  skillDirs = eval.config.resolvedSkillDirs;

  # Vendored to contrib-ext/<name> by reconverge-inputs.nix.
  outOfTreeSrcs = lib.mapAttrs (_: c: c.src) (lib.filterAttrs (_: c: !inTree c) enabled);

  # The base set plus each enabled contrib's; `tree` is `dir` vendored.
  stubSets = {
    base = { dir = ../modules/sandbox-os; tree = "modules/sandbox-os"; flakeLock = scooterFlakeLock; };
  } // lib.mapAttrs
    (name: c: {
      dir = c.src;
      tree = treeDir name c;
      flakeLock = if c.sandbox.stubs.flakeLock != null then c.sandbox.stubs.flakeLock else scooterFlakeLock;
    })
    withStubs;

  # Extra stubs.nix arguments, one namespace across sets.
  stubArgs = lib.foldl lib.attrsets.unionOfDisjoint { }
    (lib.mapAttrsToList (_: c: c.sandbox.stubs.args) withStubs);

  # Base names, not `toString`, keep the repo out of closures.
  treeRelative = lib.mapAttrsToList
    (name: c:
      let
        file = baseNameOf c.sandbox.module;
        rel = "${treeDir name c}/${file}";
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
