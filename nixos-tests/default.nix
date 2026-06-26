# Collects the dev-environment nixosTests into one attrset, so the flake can
# expose each as a `checks.<system>.<name>` (run by `nix flake check`).
#
# Each test is an independent `pkgs.testers.runNixOSTest` that boots the
# sandbox-os NixOS config in a QEMU VM with REAL systemd and asserts one
# capability. This is the FAST, deterministic tier for config correctness;
# the OCI-packaging + k8s-privilege boot stay in the Tier 2 cluster tests.
#
# See docs/DEV_ENVIRONMENT_DESIGN.md.

{ pkgs, lib ? pkgs.lib }:

let
  # The NixOS module under test — imported by each test's node.
  sandboxModule = ../modules/sandbox-os;

  runTest = path: import path { inherit pkgs lib sandboxModule; };
in
{
  dev-env-systemd-boot = runTest ./systemd-boot.nix;
  dev-env-lazy-stub = runTest ./lazy-stub.nix;
  dev-env-service = runTest ./service.nix;
  dev-env-nix-build-skill = runTest ./nix-build-skill.nix;
}
