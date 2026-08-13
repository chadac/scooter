# The MINIMAL sandbox BOOTSTRAP config (Tier C — the barebones swap-only image).
#
# DESIGN BOILERPLATE — inputs/outputs defined, implementation STUBBED (see `throw`s /
# `# IMPL:` markers). Do not ship; this is the Design stage of the PoC process.
#
# What this is: the sandbox image no longer carries the "real" system (web services,
# marimo, lazy tools, broker carry-over, …). It is a tiny bootstrap whose ONLY job is:
#   boot systemd  ->  mount the overlay upper (the cloned/warm PVC)  ->  run the first
#   `scooter-rebuild switch /etc/scooter/config`  ->  hand off to the REAL generation.
#
# The real system is defined in KUBENIX and built into the warmed PVC (a golden
# VolumeSnapshot the conversation's upper clones) as:
#   - the prebuilt toplevel + its closure in the upper's /nix/store, AND
#   - the config SOURCE flake at /etc/scooter/config  (flake.nix + the real modules).
# The agent's customizations live at /etc/scooter/config/custom (a subdir mounted from
# the WORKSPACE PVC); the root flake imports ./custom, so the switch is root-with-custom.
#
# Contrast with modules/sandbox-os (which BECOMES the real config kubenix builds into
# config/root — it is NOT imported here). See todo/docs/MINIMAL_BOOTSTRAP_SANDBOX.md.

{ config, lib, pkgs, ... }:

{
  imports = [
    # The overlay store is the ONE piece of the old config the bootstrap KEEPS: it makes
    # the cloned/warm PVC the writable upper of /nix/store, so the prebuilt closure is
    # present + the switch's generation registration lands on the PVC. Reused verbatim.
    ../sandbox-os/overlay-store.nix
    # The SHARED switch core (scooter-rebuild / scooter-env-status), used by both the
    # bootstrap and the real config — one implementation, no drift. firstboot.nix enables it.
    ../sandbox-common/scooter-switch.nix
    ./firstboot.nix
  ];

  # --- systemd base (container PID 1) ----------------------------------------
  system.stateVersion = "24.11";
  documentation.enable = lib.mkDefault false;

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

  # --- config layout (both OUTSIDE the image) --------------------------------
  # /etc/scooter/config        = the kubenix-built ROOT flake, from the warmed PVC upper.
  # /etc/scooter/config/custom = agent customizations, from the WORKSPACE PVC.
  # The root flake.nix imports ./custom. tmpfiles ensures the custom dir + the mount
  # target exist on boot (idempotent); the provisioner mounts the workspace PVC subpath
  # onto /etc/scooter/config/custom (wired in kubenix, not here).
  systemd.tmpfiles.rules = [
    "d /workspace/.scooter/custom 0755 root root -"
    # config/ itself is provided by the upper (config/root flake) — do NOT create it here;
    # only ensure the workspace-side custom dir exists for the bind.
  ];

  # NOTE (IMPL): the actual /etc/scooter/config content (the root flake) is NOT built
  # into the image — it is materialized into the PVC by the warm Job (kubenix). This
  # module only provides the SWITCH machinery + the mount points. The firstboot unit
  # (./firstboot.nix) performs `scooter-rebuild switch /etc/scooter/config` async on boot.
}
