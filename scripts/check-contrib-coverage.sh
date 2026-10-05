#!/usr/bin/env bash
# check-contrib-coverage.sh — contrib/contribs.nix must list every contrib, and a
# contrib's files must be the ones the evals look for.
#
# Both failures are silent. A contrib missing from contribs.nix is never built and
# never tested (#585). A contrib half under the WRONG FILENAME is worse: the
# platform half is found by convention (contrib/platform-modules.nix looks for
# <name>/platform.nix), so `deployment.nix` or a typo'd `platfrom.nix` is simply
# never imported — the options vanish and every manifest that sets them fails with
# "option does not exist", pointing at the manifest rather than at the file. Why:
# #585, #711.
#
# Lives here, not in Nix, because an eval-time check would need the readDir the
# explicit list exists to avoid.
set -uo pipefail
cd "$(dirname "$0")/.." || exit

fail=0
note() { echo "  - $1"; fail=1; }

# Contribs that exist on disk: a directory with a contrib.nix (its declaration).
mapfile -t on_disk < <(
  find contrib -mindepth 2 -maxdepth 2 -name contrib.nix -printf '%h\n' \
    | sed 's|^contrib/||' | sort -u
)
# Contribs contribs.nix lists: the `<name> = { dir = ./<name>; ...`  rows.
mapfile -t listed < <(
  grep -oE '^  [a-z0-9-]+ = \{ dir = \./[a-z0-9-]+;' contrib/contribs.nix \
    | awk '{print $1}' | sort -u
)

for c in "${on_disk[@]}"; do
  printf '%s\n' "${listed[@]}" | grep -qx "$c" \
    || note "contrib/$c exists but contrib/contribs.nix does not list it — it will never be built or tested"
done

for c in "${listed[@]}"; do
  [ -f "contrib/$c/contrib.nix" ] \
    || note "contrib/contribs.nix lists $c but contrib/$c/contrib.nix does not exist"
done

# A contrib's halves, each named for the eval it lands in. Anything else directly
# in a contrib directory is a half that nothing imports.
for f in contrib/*/*.nix; do
  case "${f##*/}" in
    contrib.nix | platform.nix | sandbox.nix) ;;
    *) note "$f is not one of contrib.nix / platform.nix / sandbox.nix — no eval imports it (see contrib/README.md)" ;;
  esac
done

if [ "$fail" -ne 0 ]; then
  echo "❌ contrib coverage: contrib/ is out of sync with contrib/contribs.nix"
  exit 1
fi
echo "✅ contrib coverage: all ${#on_disk[@]} contribs are listed, with only known halves"
