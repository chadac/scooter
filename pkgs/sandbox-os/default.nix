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
in
{
  inherit toplevel nixos;

  # nix build .#sandbox-os-image  ->  a nix2container image booting systemd PID 1.
  image = n2c.buildImage {
    inherit name tag;

    # rootExtras ships /sbin/init, /etc/machine-id and the writable boot dirs. Its
    # /sbin/init symlink references ${toplevel}, so the WHOLE NixOS system closure
    # is pulled into the image (and thus into the baked Nix DB below) without
    # unpacking the system root at /.
    copyToRoot = [ rootExtras ];
    maxLayers = 100;

    # Register the whole closure into a baked, read-only Nix DB and create the
    # optimiser's /nix/store/.links dir. The local-overlay store's read-only lower
    # REQUIRES both — it cannot create them read-only (NixOS/nix#11840) — and a
    # registered DB makes nix queries against the baked store correct in general.
    # This is n2c's built-in replacement for the old hand-rolled `extraCommands`
    # (nix-store --load-db + mkdir .links); it derives the DB from copyToRoot's
    # closure and additionally normalizes registrationTime=0 for reproducibility.
    initializeNixDatabase = true;

    config = {
      # Boot systemd PID 1 via the NixOS stage-2 init directly. (We also ship a
      # /sbin/init symlink for convention, but the entrypoint points at the real
      # store path so it can't be missing.)
      Entrypoint = [ "${toplevel}/init" ];
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
