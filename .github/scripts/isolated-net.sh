#!/usr/bin/env bash
# Runs a command with private loopback and /tmp, for shared onprem hosts.
set -euo pipefail
# Runner PATHs may lack util-linux and iproute2.
tools=$(nix build --no-link --print-out-paths --inputs-from . \
  "nixpkgs#util-linux^bin" "nixpkgs#iproute2^out")
for p in $tools; do PATH="$p/bin:$PATH"; done
tmp=$(mktemp -d "${RUNNER_TEMP:-/var/tmp}/isolated-tmp.XXXXXX")
# Namespace caps raise lo and mount /tmp; the command drops them.
exec unshare --user --map-current-user --net --mount --keep-caps \
  bash -c 'ip link set lo up && mount --bind "$0" /tmp &&
    exec setpriv --inh-caps=-all --ambient-caps=-all -- "$@"' "$tmp" "$@"
