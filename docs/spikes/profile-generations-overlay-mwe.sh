#!/usr/bin/env bash
# De-risk: can nix-env --set / --rollback register + roll back generations of a
# profile whose store paths live in a local-overlay store (read-only lower +
# writable upper)? The profile SYMLINKS live on the normal fs; the STORE PATHS
# they point at live in the overlay. This is the riskiest unknown for the
# agent-self-modify rollback design.
set -euo pipefail
HERE=$(mktemp -d /tmp/pgmwe.XXXXXX); mkdir -p "$HERE"/{lower,upper,work,merged/nix/store,state,profiles}
CONF=/tmp/pg-nix.conf
cat > "$CONF" <<CONF
experimental-features = nix-command flakes local-overlay-store read-only-local-store
build-users-group =
require-drop-supplementary-groups = false
sandbox = false
auto-optimise-store = false
CONF
export NIX_USER_CONF_FILES="$CONF"

echo "=== build two distinct 'system' derivations into the LOWER ==="
cat > /tmp/pg-drv.nix <<'NIX'
let sys = "x86_64-linux";
in {
  genA = derivation { name = "gen-a"; system = sys; builder = "/bin/sh"; args = [ "-c" "echo A > $out" ]; };
  genB = derivation { name = "gen-b"; system = sys; builder = "/bin/sh"; args = [ "-c" "echo B > $out" ]; };
}
NIX
A=$(nix build --no-link --print-out-paths --store "local?root=$HERE/lower" -f /tmp/pg-drv.nix genA 2>&1 | tail -1)
echo "genA in lower: $A"

unshare --user --map-root-user --mount bash -euo pipefail -c '
  HERE='"$HERE"'; export NIX_USER_CONF_FILES='"$CONF"'
  mount -t overlay overlay -o "lowerdir=$HERE/lower/nix/store,upperdir=$HERE/upper,workdir=$HERE/work" "$HERE/merged/nix/store"
  Lenc="local%3Froot=/%26real=$HERE/lower/nix/store%26read-only=true"
  store="local-overlay://?root=$HERE/merged&lower-store=$Lenc&upper-layer=$HERE/upper&state=$HERE/state&check-mount=false"
  PROFILE="$HERE/profiles/system"
  echo "=== nix-env --set genA (register generation 1) ==="
  A=$(nix build --no-link --print-out-paths --store "$store" -f /tmp/pg-drv.nix genA 2>&1 | tail -1)
  nix-env -p "$PROFILE" --store "$store" --set "$A" && echo "set genA ok"
  ls -la "$HERE/profiles/" | grep system || true
  echo "gen now: $(readlink -f $PROFILE)"
  echo "=== nix-env --set genB (register generation 2) ==="
  B=$(nix build --no-link --print-out-paths --store "$store" -f /tmp/pg-drv.nix genB 2>&1 | tail -1)
  nix-env -p "$PROFILE" --store "$store" --set "$B" && echo "set genB ok"
  ls "$HERE/profiles/" | grep -c system-.-link && echo "<- generation links"
  echo "current points at B? $(readlink -f $PROFILE | grep -q gen-b && echo yes || echo no)"
  echo "=== nix-env --rollback (back to genA) ==="
  nix-env -p "$PROFILE" --store "$store" --rollback && echo "rollback ok"
  echo "current points at A? $(readlink -f $PROFILE | grep -q gen-a && echo yes || echo no)"
'
