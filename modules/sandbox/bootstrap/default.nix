# The MINIMAL sandbox BOOTSTRAP config (Tier C — the barebones swap-only image).
#
# The sandbox image no longer carries the "real" system (web services, marimo, lazy tools,
# broker carry-over, …). It is a tiny bootstrap whose ONLY job is:
#   boot systemd  ->  mount the overlay upper (the cloned/warm PVC)  ->  run the first
#   `scooter-apply-module switch`  ->  hand off to the REAL generation.
#
# The real system is defined in KUBENIX and built into the warmed PVC (a golden
# VolumeSnapshot the conversation's upper clones) as:
#   - the prebuilt toplevel + its closure in the upper's /nix/store, AND
#   - the config SOURCE flake at /etc/scooter/config  (flake.nix + the real modules).
# The agent's customizations live at /etc/scooter/config/custom (a subdir mounted from
# the WORKSPACE PVC); the root flake imports ./custom, so the switch is root-with-custom.
#
# The real config now lives in modules/sandbox/root (moved from the old modules/sandbox-os);
# it is NOT imported here (it's what kubenix builds into config/root). See
# todo/docs/MINIMAL_BOOTSTRAP_SANDBOX.md.

{ config, lib, pkgs, ... }:

{
  imports = [
    # The overlay store: the cloned/warm PVC upper becomes the writable upper of /nix/store,
    # so the prebuilt closure is present + the switch's generation registration lands on the
    # PVC. The bootstrap ships its OWN copy (no cross-import from root — the barebones image
    # must not depend on the real config). Identical to sandbox/root/overlay-store.nix.
    ./overlay-store.nix
    # firstboot puts the SHARED scooter-apply-module / scooter-env-status derivations
    # (pkgs/sandbox-shared) on PATH + runs the boot switch. The real config puts the SAME
    # derivations on PATH, so there's one switch implementation across both images.
    ./firstboot.nix
  ];

  # --- systemd base (container PID 1) ----------------------------------------
  system.stateVersion = "24.11";
  documentation.enable = lib.mkDefault false;

  # The overlay store: the cloned/warm PVC upper becomes the writable upper of /nix/store,
  # so the prebuilt real toplevel + closure are present and firstboot's generation
  # registration lands on the PVC. Core to the model — on by default in the image.
  # (A nixosTest may leave it off; firstboot only `wants` overlay-store-setup, so the switch
  # still runs against a plain /nix/store there.) The image build (pkgs) mounts the upper.
  programs.overlayStore.enable = lib.mkDefault true;
  # firstboot switches to the real generation on boot (async).
  programs.scooterFirstboot.enable = lib.mkDefault true;

  # k8s pod networking: kubelet/CNI own it; no nscd/dhcpcd (they'd degrade the boot).
  networking.dhcpcd.enable = lib.mkDefault false;
  services.nscd.enable = lib.mkDefault false;
  system.nssModules = lib.mkForce [ ];

  # Drop the NixOS installer tools (same rationale as the real config — the switch is via
  # switch-to-configuration, never nixos-rebuild).
  system.disableInstallerTools = lib.mkDefault true;

  # --- the BAREBONES package floor -------------------------------------------
  # ONLY what boot + the first switch + basic agent-host exec need. Everything else
  # arrives with the real generation. Deliberately tiny.
  environment.systemPackages = with pkgs; [
    bashInteractive coreutils
    git                    # the "basic git utilities" floor the design calls for
    gnugrep gnused gawk    # switch-to-configuration + firstboot script helpers
    curl cacert            # fetch the agent-host directive (target store path)
    gzip gnutar            # decompress the directive if gzipped
    util-linux             # setsid (detached first switch), mount helpers
    # nix itself is provided by nix.package (below) — needed for the switch's
    # `nix-env -p …/system --set` generation registration + realizing the directive.
  ];

  # nix must be present (the switch registers a generation via nix-env; if the directive
  # is an expr rather than a bare path, nix realizes it). No nixpkgs is baked — the real
  # closure comes from the cloned upper.
  nix.enable = true;
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  # --- config layout (NO flake — scooter-rebuild builds root + custom via impure --expr) -----
  # /etc/scooter/config/root   = the real config MODULE DIR (baked in image / kubenix ConfigMap).
  # /etc/scooter/config/custom = the agent's own modules, on the WORKSPACE PVC, exposed at the
  #                              stable config path via a SYMLINK (the same proven pattern the old
  #                              /etc/scooter/modules used). The agent edits *.nix there + runs
  #                              `scooter-rebuild switch`; the switch layers custom AFTER root.
  # tmpfiles creates the PVC-side dir + the symlink on boot (idempotent). No k8s subPath mount
  # needed — the symlink into the /workspace PVC is enough (HOME=/workspace, durable).
  systemd.tmpfiles.rules = [
    "d /workspace/.scooter/custom 0755 root root -"
    "d /etc/scooter/config 0755 root root -"
    "L+ /etc/scooter/config/custom - - - - /workspace/.scooter/custom"
  ];

  # NOTE: /etc/scooter/config/root (the real config modules) is delivered separately — baked in
  # the image or mounted from a kubenix ConfigMap (next increment). This module provides the
  # SWITCH machinery + the config/custom link. firstboot runs `scooter-rebuild switch` on boot.
}
