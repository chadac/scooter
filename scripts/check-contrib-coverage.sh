#!/usr/bin/env bash
# check-contrib-coverage.sh — every contrib directory must be imported by
# contrib/all-modules.nix, and every import must name a real contrib.
#
# WHY THIS EXISTS. The import list is explicit (a readDir made every eval walk the
# directory and defeated Nix's import caching). The cost of that choice is a silent
# failure mode: add contrib/<name>/default.nix, forget the import, and the contrib
# is never built and never TESTED — nothing fails, it simply is not there. That is
# exactly the rot #573 exists to prevent for the reference contrib.
#
# Kept out of Nix eval on purpose: the whole point of the explicit list is that
# eval does not touch the filesystem, so the guard lives here and runs in `just ci`.
set -uo pipefail
cd "$(dirname "$0")/.." || exit

fail=0
note() { echo "  - $1"; fail=1; }

# Contribs that exist on disk: a directory with a default.nix (its module).
mapfile -t on_disk < <(
  find contrib -mindepth 2 -maxdepth 2 -name default.nix -printf '%h\n' \
    | sed 's|^contrib/||' | sort -u
)
# Contribs all-modules.nix imports: the relative paths in its `imports` list,
# minus the schema module itself.
mapfile -t imported < <(
  sed -n '/imports = \[/,/\];/p' contrib/all-modules.nix \
    | grep -oE '\./[a-z0-9-]+' | sed 's|^\./||' | grep -v '^options' | sort -u
)

for c in "${on_disk[@]}"; do
  printf '%s\n' "${imported[@]}" | grep -qx "$c" \
    || note "contrib/$c exists but all-modules.nix does not import ./$c — it will never be built or tested"
done

for c in "${imported[@]}"; do
  [ -f "contrib/$c/default.nix" ] \
    || note "all-modules.nix imports ./$c but contrib/$c/default.nix does not exist"
done

if [ "$fail" -ne 0 ]; then
  echo "❌ contrib coverage: contrib/all-modules.nix is out of sync with contrib/"
  exit 1
fi
echo "✅ contrib coverage: all ${#on_disk[@]} contribs are imported by all-modules.nix"
