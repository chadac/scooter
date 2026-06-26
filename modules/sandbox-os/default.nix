# The sandbox dev-environment NixOS configuration.
#
# This is the SHARED config — the capabilities (lazy tool stubs, sample service,
# in-pod nix) that must be true both in the deployed CONTAINER and in a nixosTest
# VM. Imported by both:
#   - the image build (pkgs/sandbox-os) adds `boot.isContainer = true` so systemd
#     runs as PID 1 with the kernel/udev/hardware/boot units trimmed;
#   - a nixosTest node imports this WITHOUT isContainer, so it boots as a normal
#     QEMU VM (which needs a kernel/initrd that isContainer removes) and exercises
#     the same units/stubs/services.
# Keeping `boot.isContainer` OUT of here is deliberate: it's a packaging concern,
# not a capability, and it's incompatible with the VM boot the tests rely on.
#
# See docs/DEV_ENVIRONMENT_DESIGN.md.

{ config, lib, pkgs, ... }:

{
  imports = [
    ./nix-config.nix
    ./lazy-tools.nix
    ./sample-service.nix
  ];

  # --- systemd base ----------------------------------------------------------
  system.stateVersion = "24.11";

  # No display/doc/etc. — keep it lean.
  documentation.enable = lib.mkDefault false;

  # --- nix usable in-pod (the agent builds/installs on demand) ---------------
  # cache.nixos.org egress is available in-pod (confirmed) — first-call lazy
  # stub builds substitute from it instead of building from source.
  nix.settings.substituters = lib.mkDefault [ "https://cache.nixos.org/" ];

  # Flakes + pinned `nixpkgs` registry + the user nix-profile on PATH, so
  # `nix profile install nixpkgs#x` (the skill) and `nix run nixpkgs#x` work.
  devEnvNix = {
    enable = true;
    nixpkgs = lib.mkDefault "github:NixOS/nixpkgs/nixos-unstable";
  };

  # --- base packages: DELIBERATELY MINIMAL (lazy stubs cover the rest) -------
  environment.systemPackages = with pkgs; [
    bashInteractive coreutils findutils gnugrep gnused gawk
    git curl jq gnutar gzip cacert
  ];

  # --- the lazy-tool stubs (extensible; uv shipped) --------------------------
  programs.lazyTools = {
    enable = true;
    # Built-in fallback pin; the live pod overrides via the pinFile ConfigMap.
    # STAGE 5: set this to a concrete fixed rev.
    defaultNixpkgs = lib.mkDefault "github:NixOS/nixpkgs/nixos-unstable";
    tools.uv = { package = "uv"; };
  };

  # --- the PoC sample service ------------------------------------------------
  services.sampleDevService.enable = true;

  # STAGE 5 carry-over (from the old entrypoint.sh, must not regress):
  #   - broker tools (agent-broker, git-credential-broker, scooter-aws*)
  #   - git credential.helper = broker (when BROKER_URL set)
  #   - ~/.aws/config render from the accounts ConfigMap
  #   - HOME pinned to the writable workspace for exec'd commands
  # These become packages / systemd units / activation scripts here.
}
