# The EXACT inputs the in-pod re-converge feeds base-config.nix — factored out so
# BOTH the runtime (runtime-converge.nix, which runs scooter-apply-module) and the
# nixosTest (which pre-builds the re-converged toplevel to seed the VM store) use
# the SAME derivations. If they drift, the test's pre-built `reconverged` is a
# different derivation than what the pod builds at runtime → cache miss → a
# from-source toplevel build that hangs/fails OFFLINE in the test VM.
#
# `baseConfig`  — the base-config.nix entrypoint the in-pod `nix build` imports.
# `modulesTree` — a vendored source tree placing modules/sandbox-os AND
#                 pkgs/broker-tools + the broker cli.py at the same relative layout,
#                 so the base config's `../../pkgs/broker-tools` overlay resolves.
# `modulesSrc`  — modulesPath passed to base-config.nix (<tree>/modules/sandbox-os).

{ pkgs, lib }:

let
  baseConfig = ./base-config.nix;

  modulesTree = pkgs.runCommand "sandbox-os-src" { } ''
    mkdir -p $out/modules $out/pkgs $out/services/broker/broker/aws
    cp -r ${lib.cleanSource ../.} $out/modules/sandbox-os
    cp -r ${../../../pkgs/broker-tools} $out/pkgs/broker-tools
    cp ${../../../services/broker/broker/aws/cli.py} $out/services/broker/broker/aws/cli.py
  '';
  modulesSrc = "${modulesTree}/modules/sandbox-os";
in
{ inherit baseConfig modulesTree modulesSrc; }
