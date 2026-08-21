# scooter-env-status — the agent's window into the (async) env switch. A plain derivation
# shared by both images (bootstrap + real config); pure status-reading of statusDir.
#
# Prints the current status; on failure, the error + full build/switch log so the agent can
# read the exact error and fix its config. Exit mirrors the state: 0=done/idle, 1=failed,
# 2=in-progress (building/switching). Reads ONLY statusDir — nothing image-specific.

{ lib, writeShellApplication, coreutils
, statusDir ? "/run/scooter/env-switch"
}:

writeShellApplication {
  name = "scooter-env-status";
  runtimeInputs = [ coreutils ];
  text = ''
    # scooter-env-status [--log]   show the env-switch status (+ log on failure)
    set -euo pipefail
    status_dir=${lib.escapeShellArg statusDir}
    show_log=0
    [ "''${1:-}" = "--log" ] && show_log=1
    st=$(cat "$status_dir/status" 2>/dev/null || echo idle)
    case "$st" in
      done|idle)
        echo "environment: $st (ready)"; exit 0 ;;
      building|switching)
        echo "environment: $st — the switch is still in progress; check again shortly."; exit 2 ;;
      failed)
        echo "environment: FAILED" >&2
        err=$(cat "$status_dir/error" 2>/dev/null || true)
        [ -n "$err" ] && echo "reason: $err" >&2
        echo "--- full build/switch log ---" >&2
        cat "$status_dir/log" 2>/dev/null >&2 || echo "(no log)" >&2
        exit 1 ;;
      *)
        echo "environment: $st"; [ "$show_log" -eq 1 ] && cat "$status_dir/log" 2>/dev/null || true; exit 0 ;;
    esac
  '';
}
