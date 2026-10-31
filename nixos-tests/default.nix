# Collects the dev-environment nixosTests into one attrset the flake exposes as
# `checks.<system>.<name>`. Each test boots the sandbox-os NixOS config in a QEMU
# VM with real systemd and asserts one capability; OCI packaging and the k8s
# privileged boot stay in the Tier 2 cluster tests.

{ pkgs, lib ? pkgs.lib
  # The stub overlay the image is built with, so stub-tools.nix asserts against the shims production ships.
, stubOverlay ? null
  # The BYOC controller for byoc-tunnel.nix, which runs the real binary over real
  # sockets.
, byocController ? null
  # agent-host for byoc-mcp-e2e.nix, the cloud side that replies to a tunnel open.
, agentHost ? null
  # The broker with its contribs, for forge-proxy.nix.
, broker ? null
, deploymentModules ? [ ] }:

let
  # The NixOS module under test.
  sandboxModule = ../modules/sandbox-os;

  runTest = path: import path { inherit pkgs lib sandboxModule; };
in
{
  dev-env-systemd-boot = runTest ./systemd-boot.nix;
  # Takes the stub overlay, so not a plain runTest.
  dev-env-stub-tools = import ./stub-tools.nix {
    inherit pkgs lib sandboxModule stubOverlay deploymentModules;
  };
  dev-env-service = runTest ./service.nix;
  # Commit author and Co-authored-by trailer follow the broker; repo hooks still run.
  dev-env-git-identity = runTest ./git-identity.nix;
  # The webServices option: a proxyable unit, a discovery manifest, explicit start and sub-path serving.
  dev-env-web-services = runTest ./web-services.nix;
  # contrib/files' sandbox half: the unit, the manifest entry and the base path the
  # proxy forwards, with the viewer's own behaviour left to its pytest suite.
  dev-env-contrib-files = runTest ./contrib-files.nix;
  # Web-service persistence across a pod recreate: the enabled set is recorded on the PVC and restored at boot.
  dev-env-service-persist = runTest ./service-persist.nix;
  # The mcpServers option: unit, discovery manifest, auto-assigned ports and the per-boot bearer token on loopback.
  dev-env-mcp-servers = runTest ./mcp-servers.nix;
  # The mcpServers port assertions actually fire (pure eval, no VM).
  dev-env-mcp-server-ports = runTest ./mcp-server-ports.nix;
  dev-env-nix-build-skill = runTest ./nix-build-skill.nix;
  # Runtime re-converge via a specialisation switch.
  dev-env-switch-specialisation = runTest ./switch-specialisation.nix;
  # A deployment-injected CLI tool via a mounted .scooter flake dir.
  dev-env-injected-tool = runTest ./injected-tool.nix;
  # A deployment's .scooter/module.nix applied at runtime via switch-to-configuration (heavy; nightly or the `full-nixos-tests` label only).
  dev-env-scooter-module = runTest ./scooter-module.nix;
  # The eval half of dev-env-scooter-module, cheap enough to run on every PR.
  dev-env-reconverge-eval = runTest ./reconverge-eval.nix;
  # The detached apply the boot unit runs, which re-applies local modules after a resume.
  dev-env-reconverge-detach = runTest ./reconverge-detach.nix;
  # The shell half of the same guard: the module list reaches Nix intact through scooter-apply-module (build, no VM).
  dev-env-reconverge-quoting = runTest ./reconverge-quoting.nix;
  # The deployment-default module fetch from the broker's default.tar.gz (pure eval, no VM).
  dev-env-broker-modules = runTest ./broker-modules.nix;
  # The agent's own locally-authored modules under /etc/scooter/modules (pure eval, no VM).
  dev-env-local-modules = runTest ./local-modules.nix;
  # The scooter-rebuild CLI's module subcommands and dispatch, in a real VM boot.
  dev-env-scooter-rebuild = runTest ./scooter-rebuild.nix;
  # The journal on the workspace PVC.
  dev-env-journal-persist = runTest ./journal-persist.nix;
  # The read-only-lower plus writable-upper local-overlay Nix store.
  dev-env-overlay-store = runTest ./overlay-store.nix;
}
# BYOC over real networking in a VM pair, merged conditionally so a caller that
# imports this without the packages still gets the dev-env suite.
// lib.optionalAttrs (byocController != null) {
  byoc-tunnel = import ./byoc-tunnel.nix { inherit pkgs lib byocController; };
}
# The full container -> controller -> agent-host -> broker round trip, which needs
# agent-host and three VMs.
// lib.optionalAttrs (broker != null) {
  # git/gh/glab through the shim and broker to a fake forge.
  dev-env-forge-proxy = import ./forge-proxy.nix { inherit pkgs lib sandboxModule broker; };
}
// lib.optionalAttrs (byocController != null && agentHost != null) {
  byoc-mcp-e2e = import ./byoc-mcp-e2e.nix { inherit pkgs lib byocController agentHost; };
}

