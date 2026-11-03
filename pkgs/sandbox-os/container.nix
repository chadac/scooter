# The image's container-only config, a file so every re-converge replays it.

{ lib, ... }:

{
  # Packaging-only: systemd PID 1 in a container, kernel/boot trimmed.
  boot.isContainer = true;

  # kubelet bind-mounts /etc/hosts and /etc/hostname, so NixOS must not manage them
  # or activation fails trying to replace them with store symlinks.
  environment.etc.hosts.enable = false;
  environment.etc.hostname.enable = false;

  # The writable overlay Nix store, without which `nix profile install`, lazy-tool
  # builds and the re-converge cannot write the store (see
  # modules/sandbox-os/overlay-store.nix).
  programs.overlayStore.enable = true;

  # The built-in web services are declared by default so they are startable on
  # demand, with mkDefault so a deployment can turn one off.
  webServices.terminal.enable = lib.mkDefault true;
  # Tramp and ssh clients reach the sandbox through it.
  webServices.ssh.enable = lib.mkDefault true;
}
