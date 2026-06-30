#!/usr/bin/env bash
# Minimal working example: a Nix local-overlay-store with a read-only LOWER
# (the baked image store) and a writable UPPER (the runtime volume).
#
# Proves: a build through the overlay store lands in the UPPER and leaves the
# LOWER untouched — the exact read-only-base + writable-runtime model the
# sandbox-os image wants. Runs rootless via `unshare -Urm` (no sudo, no k8s),
# which is why it's a usable iteration loop (the nixosTest VM can't validate
# this — its framework already overlays /nix/store and collides).
#
# The recipe that makes it work (see local-overlay-store-mwe.conf):
#   - lower is a REAL initialized Nix store (has nix/var/nix/db/db.sqlite),
#     not just a dir of paths. We build into it first to create the DB.
#   - build-users-group =      -> single-user mode; skips the chown-to-build-user
#                                 that fails with "Invalid argument" on overlayfs.
#   - require-drop-supplementary-groups = false  -> userns build-env quirk
#                                 (only needed for the rootless MWE; the
#                                 privileged pod won't need it).
#   - mount the overlay FIRST, then point nix at local-overlay://...
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CONF="$HERE/local-overlay-store-mwe.conf"
DRV="$HERE/local-overlay-store-mwe.drv.nix"
ROOT=$(mktemp -d /tmp/ovl-mwe.XXXXXX)
mkdir -p "$ROOT/lower" "$ROOT/upper" "$ROOT/work" "$ROOT/merged/nix/store" "$ROOT/state"
export NIX_USER_CONF_FILES="$CONF"

echo "=== 1. lower store (read-only base; build into it to create the DB) ==="
nix build --no-link --print-out-paths --store "local?root=$ROOT/lower" -f "$DRV" lower >/dev/null 2>&1 \
  && echo "lower built; DB? $([ -e "$ROOT/lower/nix/var/nix/db/db.sqlite" ] && echo yes)" || { echo "lower failed"; exit 1; }

echo "=== 2. overlay store build (in a rootless userns) ==="
unshare --user --map-root-user --mount bash -euo pipefail -c '
  ROOT="'"$ROOT"'"; DRV="'"$DRV"'"; export NIX_USER_CONF_FILES="'"$CONF"'"
  mount -t overlay overlay -o "lowerdir=$ROOT/lower/nix/store,upperdir=$ROOT/upper,workdir=$ROOT/work" "$ROOT/merged/nix/store"
  store="local-overlay://?root=$ROOT/merged&state=$ROOT/state&lower-store=$ROOT/lower&upper-layer=$ROOT/upper&check-mount=false"
  out=$(nix build --no-link --print-out-paths --store "$store" -f "$DRV" upper 2>&1) \
    || { echo "OVERLAY FAILED:"; echo "$out" | tail -6; exit 1; }
  echo "built: $out"
  base=$(basename "$out")
  [ -e "$ROOT/upper/$base" ]            && echo "PASS: new path in UPPER"   || { echo "FAIL: not in upper"; ls "$ROOT/upper"; exit 1; }
  [ -e "$ROOT/lower/nix/store/$base" ] && { echo "FAIL: leaked to lower"; exit 1; } || echo "PASS: lower untouched"
  cat "$ROOT/merged/nix/store/$base" 2>/dev/null | sed "s/^/  content: /"
'
rm -rf "$ROOT" 2>/dev/null || true
