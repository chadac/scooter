#!/usr/bin/env bash
# pg-ephemeral.sh — start or stop a throwaway local Postgres in its own temp dir.
# As root it runs the server as nobody (PGUID/PGGID override), since initdb and
# postgres refuse root.
#
# Usage: dir="$(scripts/pg-ephemeral.sh start <port>)"  # trust auth, user postgres,
#                                                       # 127.0.0.1:<port>, socket <dir>/sock
#        scripts/pg-ephemeral.sh stop <dir>             # stop it and remove <dir>
# On failure, start prints initdb's or the server's log to stderr and removes the dir.
# The server belongs to start's caller: a later start stops it once the caller is gone.
set -euo pipefail

# Runs a command as the owner of $1 when we are root.
as_owner() {
  local dir="$1"; shift
  if [ "$(id -u)" = 0 ] && [ "$(stat -c %u "$dir")" != 0 ]; then
    setpriv --reuid="$(stat -c %u "$dir")" --regid="$(stat -c %g "$dir")" --clear-groups "$@"
  else
    "$@"
  fi
}

# Prints a process's start time, which tells a reused pid apart.
proc_start() {
  local stat
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  # shellcheck disable=SC2086 # split the fields after the command name
  set -- ${stat##*) }
  printf '%s\n' "${20}"
}

stop() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  if [ -d "$dir/data" ]; then
    as_owner "$dir" pg_ctl -D "$dir/data" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$dir"
}

# Stops every server whose caller has died, e.g. from a SIGKILL.
stop_orphans() {
  local dir pid since
  for dir in "$@"; do
    [ -r "$dir/owner" ] || continue
    read -r pid since <"$dir/owner" || continue
    [ "$(proc_start "$pid" || true)" = "$since" ] && continue
    echo "pg-ephemeral: stopping $dir, its caller $pid is gone" >&2
    stop "$dir" || true
  done
}

start() {
  local port="$1" dir
  if [ "$(id -u)" = 0 ]; then
    # nix develop's TMPDIR is root-only; the server user must reach the dir.
    dir="$(mktemp -d /tmp/pg-ephemeral.XXXXXX)"
    chown "${PGUID:-$(id -u nobody)}:${PGGID:-$(id -g nobody)}" "$dir"
  else
    dir="$(mktemp -d "${TMPDIR:-/tmp}/pg-ephemeral.XXXXXX")"
  fi
  printf '%s %s\n' "$PPID" "$(proc_start "$PPID")" >"$dir/owner"
  stop_orphans "${dir%/*}"/pg-ephemeral.*
  trap 'stop "$dir"' ERR
  as_owner "$dir" mkdir "$dir/sock"
  if ! as_owner "$dir" initdb -D "$dir/data" -U postgres --auth=trust --no-sync >"$dir/initdb.log" 2>&1; then
    cat "$dir/initdb.log" >&2
    false
  fi
  if ! as_owner "$dir" pg_ctl -D "$dir/data" -w -l "$dir/pg.log" \
    -o "-k $dir/sock -c listen_addresses=127.0.0.1 -c port=$port" start >/dev/null; then
    cat "$dir/pg.log" >&2
    false
  fi
  trap - ERR
  printf '%s\n' "$dir"
}

case "${1:-}" in
  start) [ $# = 2 ] || { echo "usage: $0 start <port>" >&2; exit 2; }; start "$2" ;;
  stop) [ $# = 2 ] || { echo "usage: $0 stop <dir>" >&2; exit 2; }; stop "$2" ;;
  *) echo "usage: $0 start <port> | stop <dir>" >&2; exit 2 ;;
esac
