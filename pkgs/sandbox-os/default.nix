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
# Output: { image; toplevel; nixos; }. `image` is a nix2container image (like
# every other image in this repo), so it pushes to a registry via `.copyTo` and
# k3s pulls it — no docker-archive tarball special-case.

{ pkgs, lib, n2c
, name ? "agent-sandbox-os"
, tag ? "latest"
, extraModules ? [ ]   # let consumers layer extra NixOS config (extra tools/services)
  # nix-stubs' lib (mkLazyPackage / mkOverlay). Exposed to modules as the
  # `nixStubsLib` module arg so they can declare lazy tool shims (only the .drv is
  # baked; the built package lands in the writable store on first use). Optional so
  # the nixosTests (which import modules/sandbox-os directly) can pass null.
, nixStubsLib ? null
  # The uv-nix uv (patched for Nix): exposed to modules as the `uvNix` module arg so
  # web-services/marimo.nix can launch marimo under it (science deps import). Optional
  # so nixosTests importing modules/sandbox-os directly can pass null (marimo falls
  # back to a plain `marimo` there — see marimo.nix).
, uvNix ? null
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
  # The bare store-path STRING of that source, CONTEXT-FREE. The refs below are
  # embedded verbatim into the baked lazy-tool shims + the scooter-apply-module
  # script. base-config.nix (the runtime re-converge) discards context on the same
  # value, so these MUST match: if the image kept the store CONTEXT here, its baked
  # lazy tools would carry `nixpkgsSource` as a build INPUT while a re-converge's
  # (context-free) would not → different derivations → the first re-converge rebuilds
  # every lazy tool + system-path from source (the ~10min toolchain refetch this
  # comment block warns about). The source object is still shipped offline via
  # `system.extraDependencies` below (where it keeps its context), so the path exists.
  nixpkgsSourceStr = builtins.unsafeDiscardStringContext (toString nixpkgsSource);

  nixos = pkgs.nixos ({ lib, ... }: {
    imports = [ ../../modules/sandbox-os ] ++ extraModules;

    # nix-stubs' mkLazyPackage, available to any module as `{ nixStubsLib, ... }:`
    # (e.g. carry-over.nix declares `aws` as a lazy shim). Null in nixosTests that
    # import modules/sandbox-os without the packaging layer — the lazy-tools module
    # guards on it and falls back to a normal package there.
    _module.args.nixStubsLib = nixStubsLib;
    # The uv-nix uv, for web-services/marimo.nix. Null in nixosTests (marimo.nix
    # guards on it and falls back to a plain marimo).
    _module.args.uvNix = uvNix;

    # Packaging-only: systemd PID 1 in a container, kernel/boot trimmed.
    boot.isContainer = true;

    # kubelet bind-mounts /etc/hosts and /etc/hostname into the pod, so activation's
    # setup-etc CANNOT replace them with store symlinks — it errors "could not create
    # symlink /etc/hosts", which fails switch-to-configuration and makes the FIRST
    # scooter-rebuild switch report failure (scooter-apply-module infers success from a
    # failed-unit diff, and the failing switch unit poisons it). kubelet already writes
    # correct pod entries in both, so stop NixOS managing them. Container-only: lives
    # HERE, not modules/sandbox-os, because a nixosTest VM has a writable /etc and needs
    # the managed versions. Why: PR #489.
    environment.etc.hosts.enable = false;
    environment.etc.hostname.enable = false;

    # Overlay Nix store ALWAYS ON (the writable-store overlay is the ONE sandbox image now —
    # the plain read-only-store variant was retired). Without it /nix/store is the read-only
    # baked image layer, and the sandbox's core operations — the agent's `nix profile install`,
    # lazy-tool builds, and `scooter-rebuild` re-converge — silently can't write the store. This
    # lives HERE (the image), NOT in modules/sandbox-os, because nixosTests import that bare
    # (no baked store to overlay). The upper is a deployer-mounted volume at upperPath (the
    # provisioner's per-conversation `.scooter-rw` PVC, or a pooled warm volume).
    # See modules/sandbox-os/overlay-store.nix + todo/docs/WARM_STORE_PVC_MANAGER.md.
    programs.overlayStore.enable = true;

    # The pinned nixpkgs the lazy stubs + registry resolve against. MUST be the
    # `path:`-ref of the SAME source the re-converge uses (`pkgs.path`), so the
    # baked lazy-tool stubs are byte-identical to the ones a runtime re-converge
    # rebuilds (base-config.nix derives `path:${pkgs.path}` too). A mismatch here
    # (a bare vs path: format mismatch) makes the
    # first re-converge rebuild system-path + re-fetch the toolchain (~10min)
    # instead of being a near-noop diff against the baked store.
    programs.lazyTools.defaultNixpkgs = lib.mkForce "path:${nixpkgsSourceStr}";
    devEnvNix.nixpkgs = lib.mkForce "path:${nixpkgsSourceStr}";

    # Runtime re-converge: the pod applies a mounted .scooter/module.nix (a NixOS
    # module that declares its own tools/services, e.g. example-review) via
    # switch-to-configuration. base-config.nix `import`s this path, so it must be a
    # BARE store path (no `path:` prefix — that's a flake ref, not importable).
    programs.scooterModule = {
      enable = lib.mkDefault true;
      nixpkgs = lib.mkForce nixpkgsSourceStr;
    };
    # Ship the SAME source object the script references (see nixpkgsSource above).
    # The in-pod re-converge `nix build` imports it — offline, no fetch.
    system.extraDependencies = [ nixpkgsSource ];

    # Built-in web services ON by DEFAULT (marimo notebook, ttyd terminal, web
    # VS Code) — so they're DECLARED + listed in the manifest and startable from the
    # UI Sandbox tab / `scooter-service` out of the box. Explicit-start is unchanged:
    # they are NOT wantedBy multi-user.target, so they don't auto-run — the user/agent
    # starts them on demand. mkDefault so a deployment can still turn one off.
    webServices.marimo.enable = lib.mkDefault true;
    webServices.terminal.enable = lib.mkDefault true;
    webServices.vscode.enable = lib.mkDefault true;
  });

  toplevel = nixos.config.system.build.toplevel;

  # The Nix path-registration for the WHOLE system closure. n2c ships the store
  # *paths* but we need a REAL, registered, read-only Nix store baked in.
  closure = pkgs.closureInfo { rootPaths = [ toplevel ]; };

  # Files baked at the image root (outside the Nix store): the init symlink,
  # writable machine-id, and the dirs systemd expects to exist at first boot.
  # (Under dockerTools these last three were created in `extraCommands`; n2c has
  # no such hook, so they live here in copyToRoot instead. They become tmpfs at
  # runtime — we only need them to exist so the read-only image layer doesn't
  # block first boot.)
  rootExtras = pkgs.runCommand "sandbox-os-root" { } ''
    mkdir -p $out/sbin $out/etc
    ln -s ${toplevel}/init $out/sbin/init
    # Empty + writable: first boot seeds it (systemd machine-id contract).
    : > $out/etc/machine-id
    # systemd writes to these at boot; ship them so the read-only layer is fine.
    mkdir -p $out/var/log $out/run $out/tmp
    chmod 1777 $out/tmp
  '';

  # The baked Nix DB + the FULL /nix/var/nix state layout, at the image root. We do
  # NOT use n2c's `initializeNixDatabase`: that only bakes db/db.sqlite + gcroots/
  # docker + .links, but the local-overlay store's read-only lower opens the store
  # with `root=/`, which expects the COMPLETE state dir the real `nix-store
  # --load-db` produces (db/{schema,reserved,big-lock}, profiles/, temproots/, …).
  # With those missing, the in-pod converge failed "database does not exist, and
  # cannot be created in read-only mode". So reproduce the exact hand-rolled recipe
  # the dockerTools image used (proven against overlay-store.nix + the MWE): load the
  # closure into a real DB (which lays down the full state layout) and create the
  # optimiser's .links dir. See overlay-store.nix + NixOS/nix#11840.
  nixDb = pkgs.runCommand "sandbox-os-nixdb" { } ''
    export NIX_STATE_DIR=$out/nix/var/nix
    mkdir -p $out/nix/var/nix $out/nix/store/.links
    ${pkgs.buildPackages.nix}/bin/nix-store --load-db < ${closure}/registration
  '';

  # PID-1 wrapper: make /sys/fs/cgroup writable, THEN exec systemd.
  #
  # We run the sandbox NON-privileged under a cgroup-delegating runtime (crun) so it
  # stays in its OWN private cgroup namespace and can't churn the host cgroup tree
  # (the node-instability / host-logout bug a privileged container caused). But BOTH
  # runc and crun mount /sys/fs/cgroup READ-ONLY for a non-privileged container, and
  # systemd PID 1 needs to CREATE its cgroup subtree there — on a read-only cgroupfs it
  # exits 255 immediately after "starting systemd...". A privileged container avoided
  # this only because containerd mounts cgroupfs read-write for privileged pods. This
  # wrapper replicates just that one effect without full privilege: with CAP_SYS_ADMIN
  # (granted to the systemd sandbox — also needed by NixOS stage-2's specialfs mounts),
  # `mount -o remount,rw /sys/fs/cgroup` succeeds. Best-effort: if the cgroupfs is
  # already rw (e.g. a privileged rollback), the remount is a harmless no-op; we never
  # fail the boot on it. Then exec the real NixOS stage-2 init as PID 1.
  initWrapper = pkgs.writeScript "sandbox-init-wrapper" ''
    #!${pkgs.busybox}/bin/sh
    ${pkgs.util-linux}/bin/mount -o remount,rw /sys/fs/cgroup 2>/dev/null || true
    exec ${toplevel}/init "$@"
  '';
in
{
  inherit toplevel nixos;

  # nix build .#sandbox-os-image  ->  a nix2container image booting systemd PID 1.
  image = n2c.buildImage {
    inherit name tag;

    # rootExtras ships /sbin/init, /etc/machine-id and the writable boot dirs; nixDb
    # ships the baked Nix DB + full /nix/var/nix state layout. rootExtras's /sbin/init
    # symlink references ${toplevel}, so the WHOLE NixOS system closure is pulled into
    # the image without unpacking the system root at /. (We bake the DB ourselves via
    # nixDb rather than n2c's initializeNixDatabase — see the nixDb comment for why.)
    copyToRoot = [ rootExtras nixDb ];
    maxLayers = 100;

    config = {
      # Boot systemd PID 1 via the init WRAPPER (remounts /sys/fs/cgroup rw so systemd
      # can build its cgroup subtree under crun/non-privileged, then execs the NixOS
      # stage-2 init). See initWrapper. (We also ship a /sbin/init -> stage-2 init
      # symlink for convention; the entrypoint points at explicit store paths so
      # nothing can be missing.)
      Entrypoint = [ "${initWrapper}" ];
      # systemd's container detection: set explicitly (Docker won't).
      Env = [
        "container=docker"
        # PID 1's PATH — inherited by every kubelet `exec` (non-login `bash -c`,
        # which sources no profile). Prepend the writable per-user nix profile bin
        # (HOME is pinned to /workspace) + the setuid wrappers, so a tool from
        # `nix profile install` is immediately runnable without a login shell.
        # (sandbox-nix-profile-not-in-path bug: exec'd commands only got the minimal
        # /run/current-system/sw/bin:/usr/bin:/bin.)
        "PATH=/workspace/.nix-profile/bin:/run/wrappers/bin:/run/current-system/sw/bin:/usr/bin:/bin"
      ];
      # systemd's clean-shutdown signal differs from k8s's default SIGTERM.
      StopSignal = "SIGRTMIN+3";
      WorkingDir = "/workspace";
    };
  };
}
