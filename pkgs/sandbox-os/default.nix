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
, name ? "agent-sandbox-os"
, tag ? "latest"
, extraModules ? [ ]   # let consumers layer extra NixOS config (extra tools/services)
}:

let
  # The nixpkgs SOURCE the in-pod re-converge imports, captured as ONE store
  # object used on BOTH sides — critical, or the apply fails "path does not
  # exist" in-pod. `pkgs.path` is subtle: `toString pkgs.path` yields the flake
  # input's bare `…-source` path (a plain string, NO Nix context), while coercing
  # `pkgs.path` into a derivation (what `system.extraDependencies = [ pkgs.path ]`
  # does) re-imports it via builtins.path under a DIFFERENT, content-addressed
  # `…-source` name. So baking `toString pkgs.path` into the apply script while
  # shipping the coerced copy ships one path and references another. Pin a single
  # `builtins.path` derivation and use ITS path verbatim for both the script
  # (scooterModule.nixpkgs) and the closure (extraDependencies).
  nixpkgsSource = builtins.path { path = pkgs.path; name = "source"; };

  nixos = pkgs.nixos ({ lib, ... }: {
    imports = [ ../../modules/sandbox-os ] ++ extraModules;

    # Packaging-only: systemd PID 1 in a container, kernel/boot trimmed.
    boot.isContainer = true;

    # The pinned nixpkgs the lazy stubs + registry resolve against. MUST be the
    # `path:`-ref of the SAME source the re-converge uses (`pkgs.path`), so the
    # baked lazy-tool stubs are byte-identical to the ones a runtime re-converge
    # rebuilds (base-config.nix derives `path:${pkgs.path}` too). A mismatch here
    # (a bare vs path: format mismatch) makes the
    # first re-converge rebuild system-path + re-fetch the toolchain (~10min)
    # instead of being a near-noop diff against the baked store.
    programs.lazyTools.defaultNixpkgs = lib.mkForce "path:${nixpkgsSource}";
    devEnvNix.nixpkgs = lib.mkForce "path:${nixpkgsSource}";

    # Runtime re-converge: the pod applies a mounted .scooter/module.nix (a NixOS
    # module that declares its own tools/services, e.g. example-review) via
    # switch-to-configuration. base-config.nix `import`s this path, so it must be a
    # BARE store path (no `path:` prefix — that's a flake ref, not importable).
    programs.scooterModule = {
      enable = lib.mkDefault true;
      nixpkgs = lib.mkForce "${nixpkgsSource}";
    };
    # Ship the SAME source object the script references (see nixpkgsSource above).
    # The in-pod re-converge `nix build` imports it — offline, no fetch.
    system.extraDependencies = [ nixpkgsSource ];
  });

  toplevel = nixos.config.system.build.toplevel;

  # The Nix path-registration for the WHOLE system closure. dockerTools ships the
  # store *paths* but not a Nix DB; we load this into /nix/var/nix/db at build time
  # so the baked store is a REAL, registered, read-only Nix store. Required by the
  # local-overlay store (its read-only lower must already have a DB — it can't
  # create one read-only; see modules/sandbox-os/overlay-store.nix + the MWE), and
  # harmless/beneficial otherwise (nix queries against the baked store just work).
  closure = pkgs.closureInfo { rootPaths = [ toplevel ]; };

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

      # Register the closure into a baked Nix DB and create the optimiser's .links
      # dir, so /nix/store is a COMPLETE read-only store (DB + .links present). The
      # local-overlay store's read-only lower needs both — it cannot create them
      # read-only (NixOS/nix#11840) — and a registered DB makes nix queries against
      # the baked store correct in general.
      export NIX_STATE_DIR=$PWD/nix/var/nix
      mkdir -p nix/var/nix nix/store/.links
      ${pkgs.buildPackages.nix}/bin/nix-store --load-db < ${closure}/registration
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
