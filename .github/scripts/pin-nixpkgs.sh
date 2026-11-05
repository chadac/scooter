#!/usr/bin/env bash
# Resolve `nixpkgs#…` to the flake's locked nixpkgs for this job.
set -euo pipefail

registry="${RUNNER_TEMP:-/tmp}/scooter-flake-registry.json"
nix eval --impure --json --expr '
  let
    lock = builtins.fromJSON (builtins.readFile ./flake.lock);
    locked = lock.nodes.${lock.nodes.root.inputs.nixpkgs}.locked;
  in {
    version = 2;
    flakes = [ { from = { type = "indirect"; id = "nixpkgs"; }; to = locked; } ];
  }' > "$registry"
echo "nixpkgs# pinned to $(grep -oE '"rev":"[0-9a-f]+"' "$registry")"

# Job-scoped: `nix registry add` would outlive the job on onprem runners.
{
  echo "NIX_CONFIG<<__NIX_CONFIG__"
  [ -n "${NIX_CONFIG:-}" ] && printf '%s\n' "$NIX_CONFIG"
  echo "flake-registry = $registry"
  echo "__NIX_CONFIG__"
} >> "$GITHUB_ENV"
