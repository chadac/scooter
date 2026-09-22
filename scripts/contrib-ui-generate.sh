#!/usr/bin/env bash
# contrib-ui-generate.sh — regenerate the UI's contrib manifest.
#
# A contrib's UI half is METADATA compiled into the frontend bundle, not a
# runtime API: the brand icons are React components imported per-icon, and the
# UI is a static vite build with no module loader. So the manifest is derived
# from the evaluated contrib set at build time (contrib/ui-manifest.nix).
#
# The result is COMMITTED for this repo's own contrib set, so `npm run dev`,
# vitest and a plain `npm run build` all work without nix; `just
# contrib-ui-check` fails CI if it drifts. A deployment enabling a different set
# gets its own substituted in by ui/default.nix — it never reads this file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="ui/src"

echo "generating the contrib UI overlay in $OUT ..."
overlay="$(nix build --no-link --print-out-paths .#contrib-ui-manifest)"

# Wholesale, not merged: a contrib that lost its panel (or was removed) must not
# leave its source behind for the manifest to stop importing while tsc still
# compiles it.
rm -rf "$OUT/contrib"
cp -rT "$overlay" "$OUT/"
chmod -R u+w "$OUT/contribManifest.generated.ts" "$OUT/contribPanels.generated.ts" "$OUT/contrib" 2>/dev/null || true
echo "✅ wrote $OUT/contrib{Manifest,Panels}.generated.ts$([ -d "$OUT/contrib" ] && echo " + $OUT/contrib/")"
