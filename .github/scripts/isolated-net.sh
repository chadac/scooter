#!/usr/bin/env bash
# Runs a command with private loopback and /tmp, for shared onprem hosts.
set -euo pipefail
ip=$(command -v ip) ||
  ip=$(nix build --no-link --print-out-paths --inputs-from . "nixpkgs#iproute2^out")/bin/ip
tmp=$(mktemp -d "${RUNNER_TEMP:-/var/tmp}/isolated-tmp.XXXXXX")
# Namespace caps raise lo and mount /tmp; the command drops them.
exec unshare --user --map-current-user --net --mount --keep-caps \
  bash -c '"$0" link set lo up && mount --bind "$1" /tmp && shift &&
    exec setpriv --inh-caps=-all --ambient-caps=-all -- "$@"' "$ip" "$tmp" "$@"
