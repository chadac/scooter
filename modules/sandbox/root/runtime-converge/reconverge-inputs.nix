# The EXACT inputs the in-pod re-converge feeds base-config.nix — factored out so
# BOTH the runtime (runtime-converge.nix, which runs scooter-apply-module) and the
# nixosTest (which pre-builds the re-converged toplevel to seed the VM store) use
# the SAME derivations. If they drift, the test's pre-built `reconverged` is a
# different derivation than what the pod builds at runtime → cache miss → a
# from-source toplevel build that hangs/fails OFFLINE in the test VM.
#
# `baseConfig`  — the base-config.nix entrypoint the in-pod `nix build` imports.
# `modulesTree` — a vendored source tree placing modules/sandbox/root AND
#                 pkgs/broker-tools + pkgs/sandbox-shared + the broker cli.py at the SAME
#                 relative layout as the repo, so the config's `../../../pkgs/broker-tools`
#                 overlay AND `../../../pkgs/sandbox-shared/scooter-rebuild` callPackage (the
#                 shared switch engine runtime-converge folds onto) resolve (the copied config
#                 sits at <tree>/modules/sandbox/root — 3 deep, matching the repo, so its
#                 relative paths are byte-identical).
# `modulesSrc`  — modulesPath passed to base-config.nix (<tree>/modules/sandbox/root).

{ pkgs, lib }:

let
  baseConfig = ./base-config.nix;

  modulesTree = pkgs.runCommand "sandbox-os-src" { } ''
    mkdir -p $out/modules/sandbox $out/pkgs $out/services/broker/broker/aws
    cp -r ${lib.cleanSource ../.} $out/modules/sandbox/root
    cp -r ${../../../../pkgs/broker-tools} $out/pkgs/broker-tools
    cp -r ${lib.cleanSource ../../../../pkgs/sandbox-shared} $out/pkgs/sandbox-shared
    cp ${../../../../services/broker/broker/aws/cli.py} $out/services/broker/broker/aws/cli.py
  '';
  modulesSrc = "${modulesTree}/modules/sandbox/root";
in
{ inherit baseConfig modulesTree modulesSrc; }
