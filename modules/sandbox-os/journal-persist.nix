# The sandbox's systemd journal, on the workspace PVC instead of the container's
# writable layer.
#
# systemd PID 1 reopens its own stdio on /dev/null early in startup and logs to the
# journal instead, so `kubectl logs` on a sandbox shows stage-2 output and then
# NOTHING -- on a healthy boot and a crashed one alike. The journal is therefore the
# only record of what systemd did. By default it lives at /var/log/journal in the
# container's overlay layer (same st_dev as /), which a container restart destroys
# along with the dead rootfs: the evidence disappears at exactly the moment it is
# needed. Why: PR #703.
#
# Bound pre-systemd, in the activation script, NOT via fileSystems/a mount unit. A
# mount unit lands after local-fs.target, so journald would spend early boot writing
# to /run (tmpfs) and only reach disk at systemd-journal-flush -- losing precisely
# the early-boot crash this exists to capture. Binding before systemd starts means
# journald, with Storage=persistent, writes to the PVC from its first record.
#
# Read a retained boot with `journalctl -D <path>` (NOT --merge, which is rejected
# alongside --list-boots/-b).
#
# A bind mount, not a symlink: tmpfiles ships `z /var/log/journal` and `a+` ACL rules
# (systemd.conf, journal-nocow.conf) that refuse to follow a symlink.

{ config, lib, pkgs, ... }:

let
  cfg = config.services.scooterJournalPersist;
in
{
  options.services.scooterJournalPersist = {
    enable = lib.mkEnableOption "the PVC-backed systemd journal";

    path = lib.mkOption {
      type = lib.types.str;
      default = "/workspace/.scooter/journal";
      description = ''
        Where the journal is kept. Must be on a filesystem the kubelet has mounted
        BEFORE the container's PID 1 runs (the workspace PVC is; the scooter-rw
        store PVC is not -- it is assembled by a systemd unit).
      '';
    };

    maxUse = lib.mkOption {
      type = lib.types.str;
      default = "64M";
      description = "SystemMaxUse: cap, so system logs cannot fill the agent's workspace.";
    };

    keepBoots = lib.mkOption {
      type = lib.types.int;
      default = 3;
      description = ''
        How many prior boots' journal directories to retain. /etc/machine-id is
        regenerated on every container start, so each boot adds a machine-id
        directory; journald's own vacuuming only manages its current one.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # persistent, not auto: write to disk from the first record rather than waiting
    # for the flush that an early-boot crash never reaches.
    services.journald.settings.Journal = {
      Storage = "persistent";
      SystemMaxUse = cfg.maxUse;
    };

    system.activationScripts.scooterJournalPersist = {
      deps = [ "specialfs" ];
      text = ''
        set -u
        jdir="${cfg.path}"
        pvc="$(dirname "$(dirname "$jdir")")"

        # Report, never fail the boot: a sandbox that logs to the container layer is
        # degraded, one that does not boot is broken.
        # Idempotent: activation re-runs on every `scooter-rebuild switch`, and a
        # second bind would stack another mount over the first on each switch.
        if ${pkgs.util-linux}/bin/mountpoint -q /var/log/journal 2>/dev/null; then
          echo "sandbox-journal: /var/log/journal already bound -- nothing to do"
        elif ! ${pkgs.util-linux}/bin/mountpoint -q "$pvc" 2>/dev/null; then
          echo "sandbox-journal: $pvc is not a mountpoint -- journal stays container-local (lost on restart)"
        else
          ${pkgs.coreutils}/bin/mkdir -p "$jdir"

          # Keep the newest N boots. Oldest-first by mtime; the current boot's dir
          # does not exist yet, so N is entirely prior boots.
          keep=${toString cfg.keepBoots}
          n=$(${pkgs.coreutils}/bin/ls -1 "$jdir" 2>/dev/null | ${pkgs.coreutils}/bin/wc -l)
          if [ "$n" -gt "$keep" ]; then
            ${pkgs.coreutils}/bin/ls -1dt "$jdir"/*/ 2>/dev/null \
              | ${pkgs.coreutils}/bin/tail -n +$((keep + 1)) \
              | while read -r old; do ${pkgs.coreutils}/bin/rm -rf "$old"; done
            echo "sandbox-journal: pruned $((n - keep)) boot(s), keeping $keep"
            n=$(${pkgs.coreutils}/bin/ls -1 "$jdir" 2>/dev/null | ${pkgs.coreutils}/bin/wc -l)
          fi

          ${pkgs.coreutils}/bin/mkdir -p /var/log/journal
          if err=$(${pkgs.util-linux}/bin/mount --bind "$jdir" /var/log/journal 2>&1); then
            echo "sandbox-journal: /var/log/journal -> $jdir ($n prior boot(s) readable)"
          else
            echo "sandbox-journal: bind FAILED -- journal stays container-local (lost on restart)"
            echo "sandbox-journal: mount said: $err"
          fi
        fi
      '';
    };
  };
}
