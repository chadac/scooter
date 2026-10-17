# The sandbox dev-environment NixOS configuration shared by the image build
# (pkgs/sandbox-os) and the nixosTest VMs.
#
# `boot.isContainer` stays out of here because the VM tests need the kernel and
# initrd it removes; the image build adds it. See docs/DEV_ENVIRONMENT_DESIGN.md.

{ config, lib, pkgs, ... }:

{
  imports = [
    ./nix-config.nix
    ./stub-set.nix
    ./injected-tools.nix
    ./sample-service.nix
    ./web-services.nix
    ./contrib-skills.nix
    ./mcp-servers.nix
    ./carry-over.nix
    ./runtime-converge.nix
    ./broker-modules.nix
    ./local-modules.nix
    ./registry-modules.nix
    ./overlay-store.nix
    ./journal-persist.nix
    ./warm-store-seed.nix
    ./dbus-container.nix
  ];

  # The agent-editable modules dir lives on the workspace PVC and is exposed at
  # /etc/scooter/modules via a symlink.
  systemd.tmpfiles.rules = [
    "d /workspace/.scooter/modules 0755 root root -"
    "L+ /etc/scooter/modules - - - - /workspace/.scooter/modules"
  ];

  # The uv-nix uv for web-services/marimo.nix, null when a nixosTest imports this
  # bare.
  _module.args.uvNix = lib.mkDefault null;

  # --- systemd base ----------------------------------------------------------
  system.stateVersion = "24.11";

  documentation.enable = lib.mkDefault false;

  # The kubelet owns networking, so dhcpcd and nscd would only fail and leave the
  # system degraded.
  networking.dhcpcd.enable = lib.mkDefault false;
  services.nscd.enable = lib.mkDefault false;
  # With nscd off the NSS module set must be explicit.
  system.nssModules = lib.mkForce [ ];

  # --- nix usable in-pod (the agent builds/installs on demand) ---------------
  nix.settings.substituters = lib.mkDefault [ "https://cache.nixos.org/" ];

  # Flakes, a pinned `nixpkgs` registry and the user profile on PATH.
  devEnvNix = {
    enable = true;
    nixpkgs = lib.mkDefault "github:NixOS/nixpkgs/nixos-unstable";
  };

  # --- base packages: minimal, lazy stubs cover the rest ---------------------
  environment.systemPackages = with pkgs; [
    bashInteractive coreutils findutils gnugrep gnused gawk
    git curl jq gnutar gzip cacert
    # `setsid` lets background jobs detach into their own process group.
    util-linux

    # Lazy shims declared in stubs.nix, so listing them costs kilobytes rather
    # than closures.
    uv tree
  ];

  # Defaulted so modules can take `{ nixStubs, ... }` unconditionally; the image
  # build overrides it.
  _module.args.nixStubs = lib.mkDefault null;

  # The vendored nix-stubs bits supplied by runtime-converge/base-config.nix,
  # null elsewhere so stub-set.nix is inert.
  _module.args.stubBits = lib.mkDefault null;

  # Emits nothing until a deployment declares a tool.
  programs.injectedTools.enable = lib.mkDefault true;

  # --- the PoC sample service ------------------------------------------------
  services.sampleDevService.enable = true;

  # --- broker/git carry-over -------------------------------------------------
  # The journal is the only record of what systemd did, so it must outlive a
  # container restart.
  services.scooterJournalPersist.enable = true;

  # Broker tools, the brokered git credential helper and HOME on the workspace
  # for exec'd commands.
  programs.scooterCarryOver.enable = true;
}
