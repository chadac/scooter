# Overlay store GC: keeps the writable upper under a size cap. Pool volumes
# pass between conversations and local-path ignores the PVC size, so without
# this an upper grows until the node's disk fills.
#
# `scooter-store gc` measures the upper, and above the soft cap prunes profiles,
# re-pins what the running system needs and frees least-recently-used paths
# down to the low-water mark with nix-heuristic-gc. It runs on a timer and once
# on shutdown (before the clean-shutdown marker), so a suspended conversation
# hands back a trimmed volume.

{ config, lib, pkgs, ... }:

let
  ovl = config.programs.overlayStore;
  cfg = ovl.gc;
  upper = ovl.upperPath;
  state = "${upper}/state";
  nix = config.nix.package;

  scooterStore = pkgs.writeShellApplication {
    name = "scooter-store";
    runtimeInputs = [ pkgs.coreutils pkgs.findutils pkgs.gnugrep pkgs.gnused pkgs.gawk pkgs.sqlite nix pkgs.nix-heuristic-gc ];
    text = ''
      state=${lib.escapeShellArg state}
      lower_db=/nix/var/nix/db/db.sqlite
      live="$state/gcroots/scooter-live"
      lower_roots="$state/gcroots/scooter-lower"
      lower_dir=${lib.escapeShellArg ovl.lowerPath}
      upper_dir=${lib.escapeShellArg "${upper}/upper"}
      shopt -s nullglob
      profile_dirs=(/nix/var/nix/profiles /root/.local/state/nix/profiles /workspace/.local/state/nix/profiles /home/*/.local/state/nix/profiles)
      profiles=(/nix/var/nix/profiles/* /nix/var/nix/profiles/per-user/*/* /root/.local/state/nix/profiles/* /workspace/.local/state/nix/profiles/* /home/*/.local/state/nix/profiles/*)
      soft=''${SCOOTER_STORE_SOFT_CAP:-${toString cfg.softCap}}
      low=''${SCOOTER_STORE_LOW_WATER:-${toString cfg.lowWater}}

      usage() {
        cat <<EOF
      usage: scooter-store size             bytes held by the writable upper
             scooter-store roots            each GC root with its closure size
             scooter-store gc [--force] [--budget SECONDS]
                                            free LRU paths down to $low bytes once over $soft
      EOF
      }

      # The overlay DB lists image paths too; count the upper's.
      size() {
        if [ -e "$lower_db" ]; then
          sqlite3 -readonly "file:$state/db/db.sqlite?mode=ro" \
            "attach 'file:$lower_db?mode=ro' as lo;
             select coalesce(sum(narSize), 0) from ValidPaths where path not in (select path from lo.ValidPaths);"
        else
          sqlite3 -readonly "file:$state/db/db.sqlite?mode=ro" "select coalesce(sum(narSize), 0) from ValidPaths;"
        fi
      }

      link_root() { # <dir> <store path> <name>
        case "$2" in /nix/store/?*) [ -e "$2" ] && ln -sfn "$2" "$1/$3" ;; esac
        return 0
      }

      prune_profiles() {
        local p
        # System keeps a three-deep rollback ladder; other profiles, current only.
        if [ -e /nix/var/nix/profiles/system ]; then
          nix-env -p /nix/var/nix/profiles/system --delete-generations +4 >/dev/null 2>&1 || true
        fi
        for p in "''${profiles[@]}"; do
          if [ -L "$p" ] && [ "$p" = "''${p%-link}" ] && [ "$p" != /nix/var/nix/profiles/system ]; then
            nix-env -p "$p" --delete-generations old >/dev/null 2>&1 || true
          fi
        done
      }

      # The overlay scans only $state/gcroots; pin outside roots there.
      refresh_roots() {
        local p n=0 next="$live.new"
        rm -rf "$next"
        mkdir -p "$next"
        link_root "$next" "$(readlink -f /run/current-system || true)" current-system
        link_root "$next" "$(readlink -f /run/booted-system || true)" booted-system
        while IFS= read -r p; do
          n=$((n + 1))
          link_root "$next" "$(readlink -f "$p" || true)" "$n"
        done < <(find /nix/var/nix/gcroots "''${profile_dirs[@]}" -type l 2>/dev/null || true)
        rm -rf "$live"
        mv "$next" "$live"
        pin_lower
      }

      # Registered paths, by basename; unregistered roots are ignored by Nix.
      valid_names() {
        sqlite3 -readonly "file:$state/db/db.sqlite?mode=ro" "select path from ValidPaths;"
        if [ -e "$lower_db" ]; then
          sqlite3 -readonly "file:$lower_db?mode=ro" "select path from ValidPaths;"
        fi
      }

      # Lower-only paths free nothing but count toward nix-heuristic-gc's limit.
      pin_lower() {
        local next="$lower_roots.new"
        rm -rf "$next"
        mkdir -p "$next"
        comm -23 <(find "$lower_dir" -mindepth 1 -maxdepth 1 -name '????????????????????????????????-*' -printf '%f\n' | sort) \
          <(find "$upper_dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort) \
          | comm -12 - <(valid_names | sed 's|.*/||' | sort -u) \
          | sed "s|^|/nix/store/|" | xargs -r ln -s -t "$next" --
        rm -rf "$lower_roots"
        mv "$next" "$lower_roots"
      }

      roots() {
        refresh_roots
        nix-store --gc --print-roots 2>/dev/null | tr -d '"' | grep -v -e '^/proc/' -e "^$lower_roots/" | while read -r link _ path; do
          printf '%s\t%s\t%s\n' "$(nix path-info -S "$path" 2>/dev/null | awk '{print $2}')" "$link" "$path"
        done | sort -rn | numfmt --field=1 --to=iec-i --suffix=B
      }

      gc() {
        local force=0 budget=0 used
        while [ $# -gt 0 ]; do
          case "$1" in
            --force) force=1 ;;
            --budget) budget=$2; shift ;;
            *) usage >&2; exit 2 ;;
          esac
          shift
        done
        used=$(size)
        if [ "$force" -eq 0 ] && [ "$used" -le "$soft" ]; then
          echo "scooter-store: upper holds $(numfmt --to=iec-i "$used")B, under the $(numfmt --to=iec-i "$soft")B cap"
          return 0
        fi
        prune_profiles
        refresh_roots
        echo "scooter-store: upper holds $(numfmt --to=iec-i "$used")B; freeing down to $(numfmt --to=iec-i "$low")B"
        if [ "$used" -gt "$low" ]; then
          # Interrupting is safe: Nix unregisters each path before deleting it.
          # Unregistered paths may be lower-only; size ignores them anyway.
          if [ "$budget" -gt 0 ]; then
            timeout "$budget" nix-heuristic-gc --quiet --no-invalid "$((used - low))" || echo "scooter-store: GC stopped early (exit $?)"
          else
            nix-heuristic-gc --quiet --no-invalid "$((used - low))"
          fi
        fi
        echo "scooter-store: upper now holds $(numfmt --to=iec-i "$(size)")B"
      }

      cmd=''${1:-}
      shift || true
      case "$cmd" in
        size) size ;;
        roots) roots ;;
        gc) gc "$@" ;;
        *) usage >&2; exit 2 ;;
      esac
    '';
  };

  gcService = {
    after = [ "overlay-store-setup.service" "nix-daemon.socket" ];
    requires = [ "overlay-store-setup.service" ];
    unitConfig.ConditionPathIsDirectory = "${state}/db";
  };
in
{
  options.programs.overlayStore.gc = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = ovl.enable;
      defaultText = lib.literalExpression "config.programs.overlayStore.enable";
      description = ''
        Keep the overlay upper under {option}`softCap` by freeing
        least-recently-used store paths, on a timer and once at shutdown.
        Adds `scooter-store` (`size`, `roots`, `gc`) to the system.
      '';
    };

    softCap = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 12 * 1024 * 1024 * 1024;
      description = ''
        Bytes of upper store paths above which a GC pass runs. The default is
        60% of the platform's 20Gi `warmStore.storage`.
      '';
    };

    lowWater = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 8 * 1024 * 1024 * 1024;
      description = "Bytes a GC pass frees the upper down to (40% of 20Gi by default).";
    };

    interval = lib.mkOption {
      type = lib.types.str;
      default = "10min";
      description = "How often the running sandbox checks the soft cap (a systemd time span).";
    };

    package = lib.mkOption {
      type = lib.types.package;
      internal = true;
      readOnly = true;
      description = "The `scooter-store` CLI, for units that record the upper's size.";
    };

    stopBudget = lib.mkOption {
      type = lib.types.ints.positive;
      default = 90;
      description = ''
        Seconds the shutdown pass may spend freeing paths. It must fit, with
        the rest of shutdown, inside the pod's termination grace period.
      '';
    };
  };

  config = lib.mkIf (ovl.enable && cfg.enable) {
    environment.systemPackages = [ scooterStore ];

    programs.overlayStore.gc.package = scooterStore;

    systemd.services.scooter-store-gc = gcService // {
      description = "Free least-recently-used overlay store paths above the soft cap";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${scooterStore}/bin/scooter-store gc";
        Nice = 10;
        IOSchedulingClass = "idle";
      };
    };

    systemd.timers.scooter-store-gc = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = cfg.interval;
        OnUnitActiveSec = cfg.interval;
      };
    };

    # Stops before the clean marker, so returned volumes are trimmed.
    systemd.services.scooter-store-gc-on-stop = gcService // {
      description = "Trim the overlay store before shutdown";
      wantedBy = [ "multi-user.target" ];
      after = gcService.after ++ [ "scooter-store-clean-marker.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${pkgs.coreutils}/bin/true";
        ExecStop = "${scooterStore}/bin/scooter-store gc --budget ${toString cfg.stopBudget}";
        TimeoutStopSec = cfg.stopBudget + 15;
      };
    };
  };
}
