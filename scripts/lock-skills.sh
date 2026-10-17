#!/usr/bin/env bash
# Pin every contrib skill directory's `source` in contrib/skills.lock.
#
#   scripts/lock-skills.sh            add missing pins, keep existing ones
#   scripts/lock-skills.sh --update   re-pin every source to its default branch's HEAD
#   scripts/lock-skills.sh --check    fail if the lock is missing, stale or has extras (CI)
#
# Every DECLARED source is pinned, enabled or not, so enabling a contrib never
# needs a lock change. The lock holds the commit and narHash; contrib.nix names only
# the repo, so the lib-only evals stay pure and the in-pod re-converge never fetches.
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-}"
lock=contrib/skills.lock

# shellcheck disable=SC2016 # the ${…} below is Nix, not shell
declared=$(nix eval --impure --json --expr '
  let
    flake = builtins.getFlake (toString ./.);
    lib = flake.inputs.nixpkgs.lib;
    ev = lib.evalModules { specialArgs = { inherit lib; }; modules = [ ./contrib/all-modules.nix ]; };
  in lib.concatMapAttrs (contrib: c:
       lib.concatMapAttrs (name: s:
         lib.optionalAttrs (s.source != null) { "${contrib}/${name}" = { inherit (s) source dir; }; })
       c.skillDirs)
     ev.config.contribs')

current=$(cat "$lock" 2>/dev/null || echo '{}')

if [ "$mode" = "--check" ]; then
  problems=$(jq -rn --argjson d "$declared" --argjson l "$current" '
    ($d | to_entries[] | select(($l[.key] // null) == null) | "\(.key): not pinned"),
    ($d | to_entries[] | select(($l[.key] // null) != null and ($l[.key].source != .value.source or $l[.key].dir != .value.dir)) | "\(.key): pinned to \($l[.key].source) dir \"\($l[.key].dir)\", declared \(.value.source) dir \"\(.value.dir)\""),
    ($l | keys[] | select(($d[.] // null) == null) | "\(.): pinned but no contrib declares it")')
  if [ -n "$problems" ]; then
    echo "contrib/skills.lock is out of date (run \`just lock-skills\`):" >&2
    echo "$problems" >&2
    exit 1
  fi
  echo "contrib/skills.lock pins every declared skill source"
  exit 0
fi

out='{}'
for key in $(jq -r 'keys[]' <<<"$declared"); do
  source=$(jq -r --arg k "$key" '.[$k].source' <<<"$declared")
  dir=$(jq -r --arg k "$key" '.[$k].dir' <<<"$declared")
  existing=$(jq -c --arg k "$key" '.[$k] // empty' <<<"$current")
  if [ "$mode" != "--update" ] && [ -n "$existing" ] \
     && [ "$(jq -r .source <<<"$existing")" = "$source" ] && [ "$(jq -r .dir <<<"$existing")" = "$dir" ]; then
    out=$(jq --arg k "$key" --argjson e "$existing" '.[$k] = $e' <<<"$out")
    continue
  fi
  echo "pinning $key ($source)" >&2
  # prefetch, not `flake metadata`: a skill repo need not be a flake.
  meta=$(nix flake prefetch --refresh --json "$source")
  out=$(jq --arg k "$key" --arg source "$source" --arg dir "$dir" --argjson m "$meta" '
    .[$k] = { source: $source, dir: $dir,
              owner: $m.locked.owner, repo: $m.locked.repo,
              rev: $m.locked.rev, narHash: $m.hash }' <<<"$out")
done
jq -S . <<<"$out" > "$lock"
echo "wrote $lock" >&2
