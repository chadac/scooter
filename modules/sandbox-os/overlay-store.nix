# Overlay Nix store: whatever /nix/store currently is becomes the read-only lower
# of a local-overlay-store, and a deployer-mounted writable upper catches
# everything built at runtime.
#
# An overlayfs is mounted over /nix/store early in boot (before local-fs.target
# and nix-daemon) with the current store bind-pinned as its lower, so PID 1 and
# the running system keep working across the remount; nix is pointed at a
# `local-overlay://` store that records new paths in a state DB on the upper. The
# upper should be disk-backed (emptyDir or PVC), since a tmpfs upper charges every
# runtime build to pod memory.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.overlayStore;

  # Deleting a both-layers path leaves overlayfs's cache stale.
  remountHook = pkgs.writeShellScript "scooter-store-remount" ''
    exec ${pkgs.util-linux}/bin/mount -o remount /nix/store
  '';
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
        `.scooter-owner` names the sandbox whose GC roots and profiles `state/`
        holds; on a mismatch they are dropped at boot and the store paths kept.

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
    # One early-boot oneshot: bind-pin the lower, create the upper dirs, mount the
    # overlay over /nix/store.
    systemd.services.overlay-store-setup = {
      description = "Set up the read-only-lower + writable-upper Nix overlay store";
      wantedBy = [ "local-fs.target" ];
      before = [ "local-fs.target" "nix-daemon.service" "nix-daemon.socket" ];
      after = [ "-.mount" ];
      # No RequiresMountsFor on the upper: the pod's volume is mounted before PID 1
      # starts and systemd may never synthesize a unit for it, which would block
      # the whole boot.
      unitConfig = {
        DefaultDependencies = false;
      };
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        # A timeout leaves the store as-is rather than hanging the boot.
        TimeoutStartSec = "30s";
      };
      path = [ pkgs.util-linux pkgs.coreutils pkgs.gnugrep ];
      script = ''
        set -eu
        lower=${lib.escapeShellArg cfg.lowerPath}
        upper_root=${lib.escapeShellArg cfg.upperPath}

        # No writable volume means the store stays as-is.
        if [ ! -d "$upper_root" ]; then
          echo "overlay-store: no upper volume at $upper_root; store unchanged"
          exit 0
        fi

        # A pooled upper keeps store paths, not another sandbox's roots.
        owner=$(cat /proc/sys/kernel/hostname)
        stamp="$upper_root/.scooter-owner"
        if [ "$(cat "$stamp" 2>/dev/null || true)" != "$owner" ]; then
          state="$upper_root/state"
          rm -rf "$state/profiles" "$state/gcroots/auto" "$state/gcroots/per-user" "$state/gcroots/scooter-live"
          if [ -d "$state" ]; then mkdir -p "$state/profiles/per-user" "$state/gcroots/auto" "$state/gcroots/per-user"; fi
          printf '%s\n' "$owner" > "$stamp"
          echo "overlay-store: upper now owned by $owner; dropped prior roots and profiles"
        fi

        # Nothing to do when /nix/store is already this overlay.
        if grep -qs "upperdir=$upper_root/upper" /proc/self/mountinfo; then
          echo "overlay-store: already mounted"
          exit 0
        fi

        mkdir -p "$lower" "$upper_root/upper" "$upper_root/work" "$upper_root/state"

        # Bind-pin the current /nix/store at $lower as a read-only lowerdir.
        if ! mountpoint -q "$lower"; then
          mount --bind /nix/store "$lower"
          # A shared peer group could propagate writes around the ro flag.
          mount --make-private "$lower"
          mount -o remount,bind,ro "$lower"
        fi

        opts="lowerdir=$lower,upperdir=$upper_root/upper,workdir=$upper_root/work"
        # In a user namespace trusted.* xattrs are unwritable; without user ones
        # every directory rename fails EXDEV and Nix can't add store paths.
        if ! grep -qE '^ *0 +0 +4294967295 *$' /proc/self/uid_map; then
          opts="$opts,userxattr"
        fi

        # Mount the overlay over /nix/store; reads fall through to the lower.
        mount -t overlay scooter-store -o "$opts" /nix/store
        echo "overlay-store: /nix/store = ro($lower) + rw($upper_root/upper)"
      '';
    };

    nix.settings = {
      # The lower is a nested, percent-encoded store URI whose root=/ reads the
      # existing system state DB and whose real= is the read-only bind.
      store =
        let
          lowerStore = "local?root=/&real=${cfg.lowerPath}&read-only=true";
          enc = builtins.replaceStrings [ "?" "&" ] [ "%3F" "%26" ] lowerStore;
        in
        "local-overlay://?root=/"
        + "&lower-store=${enc}"
        + "&upper-layer=${cfg.upperPath}/upper"
        + "&state=${cfg.upperPath}/state"
        + "&check-mount=false"
        + "&remount-hook=${remountHook}";

      experimental-features = lib.mkAfter [ "local-overlay-store" "read-only-local-store" ];

      # The chown to a build-user group fails on the overlayfs store.
      build-users-group = "";

      # The optimiser writes hardlinks under the read-only lower's .links.
      auto-optimise-store = false;
    };
  };
}
