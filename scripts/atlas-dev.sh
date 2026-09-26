#!/usr/bin/env bash
# atlas-dev.sh — run an Atlas command against an EPHEMERAL, per-invocation local
# Postgres, then tear it down. Atlas needs a throwaway "dev" database to normalize
# each schema.sql and compute diffs; this spins one on a private socket in a temp
# dir so nothing is shared and concurrent runs (e.g. parallel CI PRs) cannot
# interfere.
#
# Self-contained: if `initdb`/`atlas` aren't already on PATH (i.e. you're not in the
# dev shell), it re-execs itself inside `nix shell nixpkgs#postgresql_16
# nixpkgs#atlas`, so it works standalone from a bare checkout.
#
# Usage: scripts/atlas-dev.sh <atlas args...>
#   scripts/atlas-dev.sh migrate diff my_change --env webhooks
#   scripts/atlas-dev.sh migrate validate --env broker
# ATLAS_DEV_URL is exported into the atlas invocation; atlas.hcl reads it as `dev`.
set -euo pipefail

# Pull Postgres (+ Atlas) from nixpkgs on demand rather than requiring them in the
# ambient shell. The guard var stops an infinite re-exec.
if [ -z "${ATLAS_DEV_NIX:-}" ] && { ! command -v initdb >/dev/null 2>&1 || ! command -v atlas >/dev/null 2>&1; }; then
  export ATLAS_DEV_NIX=1
  exec nix shell nixpkgs#postgresql_16 nixpkgs#atlas -c "$0" "$@"
fi

here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
pgdata="$tmp/data"
sock="$tmp/sock"
mkdir -p "$sock"

cleanup() {
  pg_ctl -D "$pgdata" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# A random high port avoids collisions with any local server / parallel runs.
port=$(( (RANDOM % 20000) + 40000 ))

# initdb refuses to run as root, and `2>&1` used to discard the one line that says so — under
# `set -e` the whole script then exited 1 with NO output at all, from any root environment (a dev
# container, a sandbox, a root shell). CI is not root, so main stayed green and only local work hit
# it. Keep stdout quiet (initdb is chatty on success); never hide stderr.
if [ "$(id -u)" = 0 ]; then
  echo "atlas-dev.sh: refusing to run as root — initdb will not run as root." >&2
  echo "  Re-run as an unprivileged user, e.g.:  su -s \"\$(command -v bash)\" <user> -c '$0 $*'" >&2
  exit 1
fi
initdb -D "$pgdata" -U postgres --auth=trust >/dev/null
pg_ctl -D "$pgdata" \
  -o "-k $sock -c listen_addresses=127.0.0.1 -c port=$port" \
  -l "$tmp/pg.log" start >/dev/null

# Wait until it accepts connections.
for _ in $(seq 1 30); do
  if psql -h 127.0.0.1 -p "$port" -U postgres -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 0.5
done
createdb -h 127.0.0.1 -p "$port" -U postgres atlasdev

export ATLAS_DEV_URL="postgres://postgres@127.0.0.1:$port/atlasdev?sslmode=disable&search_path=public"

cd "$here/lib/sql"
atlas "$@"
