#!/usr/bin/env bash
# check-contrib-coverage.sh — contrib/all-modules.nix must import every contrib, and
# a contrib's files must be the ones the evals look for.
#
# Both failures are silent. A contrib missing from all-modules.nix is never built and
# never tested (#585). A contrib half under the WRONG FILENAME is worse: a half is
# found beside the declaration by name (modules/platform.nix looks for
# <name>/deployment.nix), so a typo like `deploymnet.nix` is simply never imported — the options vanish, and every manifest that sets them fails
# with "option does not exist", pointing at the manifest rather than at the file.
# Why: #585, #711.
#
# Lives here, not in Nix, because an eval-time check would need the readDir the
# explicit import list exists to avoid.
set -uo pipefail
cd "$(dirname "$0")/.." || exit

fail=0
note() { echo "  - $1"; fail=1; }

# Contribs that exist on disk: a directory with a contrib.nix (its declaration).
mapfile -t on_disk < <(
  find contrib -mindepth 2 -maxdepth 2 -name contrib.nix -printf '%h\n' \
    | sed 's|^contrib/||' | sort -u
)
# Contribs all-modules.nix imports: the relative paths in its `imports` list,
# minus the schema module itself.
mapfile -t imported < <(
  sed -n '/imports = \[/,/\];/p' contrib/all-modules.nix \
    | grep -oE '\./[a-z0-9-]+/contrib\.nix' \
    | sed 's|^\./||; s|/contrib\.nix$||' | sort -u
)

for c in "${on_disk[@]}"; do
  printf '%s\n' "${imported[@]}" | grep -qx "$c" \
    || note "contrib/$c exists but all-modules.nix does not import ./$c/contrib.nix — it will never be built or tested"
done

for c in "${imported[@]}"; do
  [ -f "contrib/$c/contrib.nix" ] \
    || note "all-modules.nix imports ./$c/contrib.nix but that file does not exist"
done

# A contrib's halves, each named for the eval it lands in. Anything else directly
# in a contrib directory is a half that nothing imports.
for f in contrib/*/*.nix; do
  case "${f##*/}" in
    contrib.nix | deployment.nix | sandbox.nix) ;;
    *) note "$f is not one of contrib.nix / deployment.nix / sandbox.nix — no eval imports it (see contrib/README.md)" ;;
  esac
done

if [ "$fail" -ne 0 ]; then
  echo "❌ contrib coverage: contrib/ is out of sync with contrib/all-modules.nix"
  exit 1
fi
echo "✅ contrib coverage: all ${#on_disk[@]} contribs are imported, with only known halves"
