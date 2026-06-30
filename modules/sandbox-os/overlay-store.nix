# Overlay Nix store: whatever /nix/store currently is becomes the READ-ONLY LOWER
# of a local-overlay-store; a writable UPPER (a deployer-mounted volume) catches
# everything built at runtime (lazy stubs, in-pod nix, runtime-converge). So the
# base closure is immutable and runtime mutations are isolated + discardable.
#
# Mechanism (https://nix.dev/manual/nix/2.22/store/types/experimental-local-overlay-store):
#   - overlayfs mounts lowerdir=<current store> + upperdir=<volume> + workdir=<volume>
#     OVER /nix/store, so /nix/store is the merged view (reads see the base
#     closure, writes land in the upper);
#   - nix is configured with a `local-overlay://` store so it records new paths in
#     a separate state DB on the upper (the lower's read-only DB is the base).
#
# COMPOSE-ON-TOP, not assume-baked-dir. We bind-pin whatever /nix/store IS as our
# lower, so this works identically for:
#   - the baked OCI image store (the k8s/Docker prod path),
#   - a bare /nix/store on an EC2/VM host (the non-container path — first-class:
#     we may run this sandbox OS outside Docker),
#   - the nixosTest framework's OWN /nix/store overlay (so the VM test can run).
# In every case the current store becomes our read-only lower; writes go up.
#
# CONTAINER/VM BOOT ORDERING (the fiddly part): systemd PID 1 + the running system
# exec FROM /nix/store, so we must NOT remount it out from under them. We overlay
# /nix/store EARLY (ordered before local-fs.target + nix-daemon) with the current
# store bind-pinned as the lower first — the lower still exposes every running
# path, so PID 1 keeps working across the remount.
#
# The UPPER is deployer-configurable: mount an emptyDir (ephemeral, default), a
# tmpfs, or a PVC (persist runtime builds across suspend/resume) at upperPath.
# It MUST be disk-backed (emptyDir/PVC) in prod, NOT tmpfs — a RAM upper charges
# every runtime-built closure (incl. the ~hundreds-of-MB module rebuild) to pod
# memory.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.overlayStore;
in
{
  options.programs.overlayStore = {
    enable = lib.mkEnableOption "the read-only-lower + writable-upper Nix overlay store";

    upperPath = lib.mkOption {
      type = lib.types.str;
      default = "/nix/.scooter-rw";
      description = ''
        Mount point of the writable volume backing the overlay UPPER + WORK +
        STATE. The deployer mounts a volume here (emptyDir/tmpfs/PVC). Three
        subdirs are used: `upper/` (the overlay upperdir), `work/` (overlayfs
        workdir, must be on the same volume as upper), and `state/` (the
        local-overlay store's own Nix DB for new paths). If the volume isn't
        mounted, the store stays as-is (no upper) — degrade, don't break.

        Named `.scooter-rw` (not `.rw-store`/`.ro-store`) to avoid colliding with
        the nixosTest VM framework's own store-overlay paths.
      '';
    };

    lowerPath = lib.mkOption {
      type = lib.types.str;
      default = "/nix/.scooter-ro";
      description = ''
        Where the CURRENT /nix/store is bind-pinned as a stable read-only lowerdir
        before our overlay is mounted over /nix/store. Composes ON TOP of whatever
        /nix/store already is — a plain baked dir (the real OCI image), a bare
        host store (EC2/VM), OR an existing overlay (the nixosTest framework).
        Either way it becomes our lower; writes land in the upper.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # The overlay-store boot sequence is one ordered oneshot:
    #
    #  1. bind /nix/store -> lowerPath        (a stable read-only lowerdir)
    #  2. ensure upperPath/{upper,work,state} exist (on the mounted volume)
    #  3. overlay-mount (lower+upper+work) OVER /nix/store
    #
    # Runs in early boot, before local-fs.target + nix-daemon, so subsequent execs
    # + the agent's nix builds use the merged store with writes going to the upper.
    systemd.services.overlay-store-setup = {
      description = "Set up the read-only-lower + writable-upper Nix overlay store";
      wantedBy = [ "local-fs.target" ];
      before = [ "local-fs.target" "nix-daemon.service" "nix-daemon.socket" ];
      after = [ "-.mount" ];
      # Order AFTER the upper volume's mount unit (and require it) — the overlay
      # is useless until the writable upper is present. RequiresMountsFor resolves
      # cfg.upperPath to its (escaped) .mount unit and orders us after it, so we
      # don't race the volume mount and fall into the "no upper volume" degrade
      # path. Without this, `before local-fs.target` runs us too early.
      unitConfig = {
        DefaultDependencies = false;
        RequiresMountsFor = [ cfg.upperPath ];
      };
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      path = [ pkgs.util-linux pkgs.coreutils pkgs.gnugrep ];
      script = ''
        set -eu
        lower=${lib.escapeShellArg cfg.lowerPath}
        upper_root=${lib.escapeShellArg cfg.upperPath}

        # No writable volume mounted -> leave the store as-is. Degrade, don't break
        # (the image still works; it just can't build new paths at runtime).
        if [ ! -d "$upper_root" ]; then
          echo "overlay-store: no upper volume at $upper_root; store unchanged"
          exit 0
        fi

        # Idempotent: if /nix/store is already OUR overlay (upperdir under
        # $upper_root), nothing to do.
        if grep -qs "upperdir=$upper_root/upper" /proc/self/mountinfo; then
          echo "overlay-store: already mounted"
          exit 0
        fi

        mkdir -p "$lower" "$upper_root/upper" "$upper_root/work" "$upper_root/state"

        # 1. Bind-pin the CURRENT /nix/store at $lower as a stable READ-ONLY
        #    lowerdir. Composes on top of whatever /nix/store already is. The
        #    two-step bind + remount-ro is the reliable way to get a read-only bind.
        if ! mountpoint -q "$lower"; then
          mount --bind /nix/store "$lower"
          # Make the bind PRIVATE before remounting ro: if it stays in the source's
          # shared peer group, mount propagation can route writes around our ro
          # flag (observed when the current /nix/store is itself a writable overlay,
          # e.g. the nixosTest framework's). Private + ro = a truly read-only lower.
          mount --make-private "$lower"
          mount -o remount,bind,ro "$lower"
        fi

        # 2. Overlay (ro lower + rw upper + work) OVER /nix/store. Reads fall
        #    through to the lower (every running store path stays visible -> PID 1
        #    keeps working); writes land in the upper.
        mount -t overlay scooter-store \
          -o "lowerdir=$lower,upperdir=$upper_root/upper,workdir=$upper_root/work" \
          /nix/store
        echo "overlay-store: /nix/store = ro($lower) + rw($upper_root/upper)"
      '';
    };

    nix.settings = {
      # Tell Nix this is a local-overlay store so it records new paths against the
      # upper's own state DB (the lower's read-only DB is the immutable base).
      #   root        = merged store root (/, so the store dir is /nix/store)
      #   lower-store = a NESTED store URI (URL-encoded) for the read-only lower:
      #                 `local?root=/&real=<lowerPath>&read-only=true`.
      #                 - root=/      -> the lower reads the EXISTING system state
      #                                  (DB at /nix/var/nix/db, profiles, gcroots).
      #                                  This is what avoids "database does not
      #                                  exist" / "creating .links|profiles:
      #                                  Read-only" — the real store already has a
      #                                  complete state dir; we just don't write it.
      #                 - real=<lower> -> the lower's actual store DIR is our frozen
      #                                  read-only bind of /nix/store, NOT /nix/store
      #                                  itself (which is now OUR overlay).
      #                 - read-only=true -> never write the lower (required; #11840
      #                                  means the flag alone is incomplete, hence
      #                                  the root=/ existing-state trick above).
      #                 The nested ?/& are percent-encoded so the outer URI keeps
      #                 them attached to lower-store. (The flat `lower-store.real=`
      #                 form is rejected as an unknown setting — it must be nested.)
      #   upper-layer = the overlay upperdir (where new path *files* land)
      #   state       = the upper's writable state dir (the new-paths DB)
      #   check-mount = off; we manage the overlayfs mount in overlay-store-setup.
      store =
        let
          lowerStore = "local?root=/&real=${cfg.lowerPath}&read-only=true";
          enc = builtins.replaceStrings [ "?" "&" ] [ "%3F" "%26" ] lowerStore;
        in
        "local-overlay://?root=/"
        + "&lower-store=${enc}"
        + "&upper-layer=${cfg.upperPath}/upper"
        + "&state=${cfg.upperPath}/state"
        + "&check-mount=false";

      experimental-features = lib.mkAfter [ "local-overlay-store" "read-only-local-store" ];

      # Single-user mode: skip the chown-to-build-user-group that fails with
      # "changing ownership ...: Invalid argument" on the overlayfs store. (Proven
      # necessary by docs/spikes/local-overlay-store-mwe.sh.)
      build-users-group = "";

      # The store optimiser writes hardlinks under <lower>/.links — but the lower
      # is read-only, so any optimise attempt fails with "creating directory
      # /nix/.scooter-ro/.links: Read-only file system". Disable it; runtime store
      # paths land un-deduplicated in the upper (fine — the upper is discardable).
      auto-optimise-store = false;
    };
  };
}
