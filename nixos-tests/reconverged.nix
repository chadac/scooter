# The re-converged toplevel that `scooter-apply-module` builds in the pod, as one
# expression shared by scooter-module.nix (which pre-seeds its closure so the in-pod
# build is an offline cache hit) and reconverge-eval.nix (which evaluates it on
# every PR). The toplevel built here must be byte-identical to the one the pod builds.

{ pkgs, lib }:

let
  scooterFixture = ./fixtures/scooter;

  # An out-of-tree contrib, composed as pkgs/sandbox-os does.
  contribSandbox = import ../contrib/sandbox-modules.nix {
    inherit lib;
    extraModules = [ ./fixtures/contrib-ext/contrib.nix ];
  };

  # The exact inputs the in-pod build feeds base-config.nix, from the helper runtime-converge.nix uses.
  reconvergeInputs = import ../modules/sandbox-os/runtime-converge/reconverge-inputs.nix {
    inherit pkgs lib;
    contribSrcs = contribSandbox.outOfTreeSrcs;
  };
in
rec {
  inherit contribSandbox;

  # The nixpkgs source the in-pod build imports, copied into the store as a realised derivation output the VM definitely has.
  nixpkgsSrc = pkgs.runCommand "nixpkgs-src" { } ''
    cp -r ${pkgs.path} $out
  '';

  # The modules layered into every re-converge; the test node threads the same list through programs.scooterModule.extraReconvergeModules.
  vmModules = [
    ./fixtures/keep-vm-units.nix

    # Re-declare the mounted `.scooter/module.nix` so the environment.etc symlink survives the switch, interpolated to a store path so the module system does not read the derivation's attributes as options.
    "${pkgs.writeText "keep-scooter-etc.nix" ''
      { ... }:
      {
        environment.etc."agent-sandbox/scooter/module.nix".source =
          "${scooterFixture}/module.nix";
      }
    ''}"
  ];

  # Layers as the pod renders them: VM modules, then contrib.
  layers = vmModules
    ++ map (f: "${reconvergeInputs.modulesTree}/${f}") contribSandbox.treeRelative;

  # The carry list as the pod embeds it, with the string context discarded so reconverge-modules.json and the toplevel hash identically.
  carry = map (m: builtins.unsafeDiscardStringContext "${m}") layers;

  # Mirrors what scooter-apply-module builds exactly, passing `nixpkgs` and `modulesPath` with their store context so pure eval can import them.
  toplevel = (import reconvergeInputs.baseConfig {
    nixpkgs = toString nixpkgsSrc;
    modulesPath = reconvergeInputs.modulesSrc;
    system = pkgs.system;
    # The same order the in-pod build uses: the layers, the carry module scooter-apply-module emits, then the mounted module last.
    extraModules =
      layers
      ++ [{ programs.scooterModule.extraReconvergeModules = carry; }]
      ++ [ "${scooterFixture}/module.nix" ];
  }).toplevel;
}
