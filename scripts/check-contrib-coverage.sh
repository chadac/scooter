#!/usr/bin/env bash
# check-contrib-coverage.sh — contrib/all-modules.nix must import every contrib,
# and a contrib's files must be the ones the evals look for. A contrib missing
# from all-modules.nix is never built or tested, and a half under the wrong
# filename is never imported, so its options vanish. Lives here rather than in
# Nix because an eval-time check would need the readDir the explicit import list
# exists to avoid.
set -uo pipefail
cd "$(dirname "$0")/.." || exit

fail=0
note() { echo "  - $1"; fail=1; }

# Contribs that exist on disk: a directory with a contrib.nix (its declaration).
mapfile -t on_disk < <(
  find contrib -mindepth 2 -maxdepth 2 -name contrib.nix -exec dirname {} \; \
    | sed 's|^contrib/||' | sort -u
)
# Zero means the scan broke, not that there's nothing to check.
[ "${#on_disk[@]}" -gt 0 ] || { echo "❌ contrib coverage: found no contrib/*/contrib.nix"; exit 1; }
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

# A contrib's halves, each named for the eval it lands in; anything else in a
# contrib directory is a half nothing imports.
for f in contrib/*/*.nix; do
  case "${f##*/}" in
    contrib.nix | deployment.nix | sandbox.nix | module.nix | stubs.nix) ;;
    *) note "$f is not one of contrib.nix / deployment.nix / sandbox.nix / module.nix / stubs.nix — no eval imports it (see contrib/README.md)" ;;
  esac
done

# A stub set needs both stubs.nix and stubs.lock.
for d in contrib/*/; do
  d=${d%/}
  if [ -f "$d/stubs.nix" ] && [ ! -f "$d/stubs.lock" ]; then
    note "$d/stubs.nix has no stubs.lock beside it — run \`just stubs\`"
  elif [ -f "$d/stubs.lock" ] && [ ! -f "$d/stubs.nix" ]; then
    note "$d/stubs.lock has no stubs.nix beside it — delete it, or restore stubs.nix"
  fi
done

# Settings-tab code is linted, type-checked and chunked only as contrib/<name>/ui/*.tsx,
# so a .tsx anywhere else in a contrib is a tab file none of that sees. Exempt: a
# standalone app with its own package.json (files/viewer-ui), and the lint fixture.
while IFS= read -r f; do
  case "$f" in
    contrib/*/ui/lint-fixture/*) continue ;;
  esac
  [[ "$f" =~ ^contrib/[^/]+/ui/[^/]+\.tsx$ ]] && continue
  d=$(dirname "$f") standalone=0
  while [ "$d" != contrib ] && [ "$d" != . ]; do
    [ -f "$d/package.json" ] && { standalone=1; break; }
    d=$(dirname "$d")
  done
  [ "$standalone" -eq 1 ] \
    || note "$f is not directly in its contrib's ui/ — settings-tab files must be contrib/<name>/ui/*.tsx, or the UI build, typecheck and lint never see them"
done < <(git ls-files -co --exclude-standard 'contrib/**/*.tsx' | grep -v /node_modules/)

if [ "$fail" -ne 0 ]; then
  echo "❌ contrib coverage: contrib/ is out of sync with contrib/all-modules.nix"
  exit 1
fi
echo "✅ contrib coverage: all ${#on_disk[@]} contribs are imported, with only known halves and tab files in ui/"
