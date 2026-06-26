# NixOS dev-environment sandbox image: a NixOS toplevel -> OCI, booting systemd
# as PID 1. There is no maintained nixpkgs helper for "NixOS-as-OCI-with-systemd",
# so this is the hand-rolled recipe (see docs/DEV_ENVIRONMENT_DESIGN.md +
# the research in memory dev-environment-nixos-config):
#
#   - evaluate the shared sandbox-os NixOS config WITH `boot.isContainer = true`
#     (trims kernel/udev/hardware/boot units, keeps systemd userspace; the init
#     then lives at ${toplevel}/init);
#   - build an OCI image whose entrypoint is that init (systemd PID 1):
#       /sbin/init -> ${toplevel}/init, Cmd = ["/init"];
#   - set `container=docker` EXPLICITLY (Docker doesn't auto-set it, and systemd
#     needs it to run the slimmed container boot);
#   - ship an empty, writable /etc/machine-id so first boot initializes it.
#
# `boot.isContainer` lives HERE (not in modules/sandbox-os) on purpose: it removes
# the kernel/initrd that a nixosTest VM needs, so it's a packaging concern, not a
# capability. The nixosTests import the shared config without it.
#
# Output: { image; toplevel; nixos; }. `image` is a dockerTools layered image
# (tarball-producing) so the cluster-up importers (`k3s ctr images import`, etc.)
# can load it.

{ pkgs, lib
, nixpkgsPinned        # the pinned nixpkgs ref string for the lazy stubs / registry
, name ? "agent-sandbox-os"
, tag ? "latest"
, extraModules ? [ ]   # let consumers layer extra NixOS config (extra tools/services)
}:

let
  nixos = pkgs.nixos ({ lib, ... }: {
    imports = [ ../../modules/sandbox-os ] ++ extraModules;

    # Packaging-only: systemd PID 1 in a container, kernel/boot trimmed.
    boot.isContainer = true;

    # The pinned nixpkgs the lazy stubs + registry resolve against, threaded from
    # the flake input so it's a fixed rev (deterministic).
    programs.lazyTools.defaultNixpkgs = lib.mkForce nixpkgsPinned;
    devEnvNix.nixpkgs = lib.mkForce nixpkgsPinned;
  });

  toplevel = nixos.config.system.build.toplevel;

  # Files baked at the image root (outside the Nix store): the init symlink,
  # writable machine-id, and the dirs systemd expects to exist.
  rootExtras = pkgs.runCommand "sandbox-os-root" { } ''
    mkdir -p $out/sbin $out/etc
    ln -s ${toplevel}/init $out/sbin/init
    # Empty + writable: first boot seeds it (systemd machine-id contract).
    : > $out/etc/machine-id
  '';
in
{
  inherit toplevel nixos;

  # nix build .#sandbox-os-image  ->  a layered OCI tarball booting systemd PID 1.
  image = pkgs.dockerTools.buildLayeredImage {
    inherit name tag;

    contents = [ rootExtras ];

    # The whole NixOS system closure must be present in the image.
    includeStorePaths = true;
    maxLayers = 100;

    # Make the store generation visible at /run/current-system etc. happens at
    # boot via the init; we only need the closure + the init entrypoint here.
    extraCommands = ''
      # systemd writes to these at boot; create them so the read-only image layer
      # doesn't block first boot (they become tmpfs at runtime).
      mkdir -p var/log run tmp
      chmod 1777 tmp
    '';

    config = {
      # Boot systemd PID 1 via the NixOS stage-2 init directly. (We also ship a
      # /sbin/init symlink for convention, but the entrypoint points at the real
      # store path so it can't be missing.)
      Entrypoint = [ "${toplevel}/init" ];
      # systemd's container detection: set explicitly (Docker won't).
      Env = [
        "container=docker"
        "PATH=/run/current-system/sw/bin:/usr/bin:/bin"
      ];
      # systemd's clean-shutdown signal differs from k8s's default SIGTERM.
      StopSignal = "SIGRTMIN+3";
      WorkingDir = "/workspace";
    };
  };
}
