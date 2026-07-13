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
  # The webServices option: renders a proxyable unit + discovery manifest,
  # explicit-start, sub-path serving (the reverse-proxy target contract).
  dev-env-web-services = runTest ./web-services.nix;
  dev-env-nix-build-skill = runTest ./nix-build-skill.nix;
  # SPIKE: runtime re-converge (warm-pod-specializes-on-claim primitive).
  dev-env-switch-specialisation = runTest ./switch-specialisation.nix;
  # Deployment-injected CLI tool via a mounted .scooter flake dir (the generic
  # mechanism; a deployment ships its own real tool, e.g. example-review).
  dev-env-injected-tool = runTest ./injected-tool.nix;
  # mkLazyTool used DIRECTLY in a module (inline lazy-tool declaration, multi-command).
  dev-env-mklazytool = runTest ./mklazytool.nix;
  # A deployment's .scooter/module.nix (a NixOS module declaring its own tools)
  # applied at runtime via switch-to-configuration. The no-rebuild injection path.
  dev-env-scooter-module = runTest ./scooter-module.nix;
  # The read-only-lower + writable-upper local-overlay Nix store (clean immutable
  # base + a writable upper for runtime builds). Composes on top of whatever
  # /nix/store is — baked OCI store, bare EC2/VM host store, or the framework's
  # own VM overlay — so this VM test exercises the real mechanism.
  dev-env-overlay-store = runTest ./overlay-store.nix;
}
