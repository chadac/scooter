#!/usr/bin/env bash
# image-sizes.sh — measure the on-disk size of every shipped container image and
# emit it as JSON, for the CI image-size benchmark (report + compare vs origin/main).
#
# Every image is nix2container: the build output is a recipe *.json that REFERENCES
# the store paths which become the pushed layers — so the honest "how big is the
# thing we push" is `nix path-info -S` (total closure size) of that recipe, NOT the
# recipe file's own bytes (which is a tiny ~80KB JSON). Measuring the file (an old
# tarball-era shortcut) reported sandbox-os as ~empty once it became n2c.
#
# Output (stdout): a JSON array [ {"name","bytes","kind"}, ... ], sorted by name.
# Build logs + progress go to stderr so stdout stays pure JSON (pipe to jq / a file).
#
# Usage:
#   scripts/image-sizes.sh                 # measure all images
#   scripts/image-sizes.sh agent-host-image broker-image   # a subset
#
# Cachix-backed: unchanged images are substituted (near-instant), so measuring both
# the PR and origin/main in one job only rebuilds what actually changed.
set -euo pipefail

# attr -> measurement kind. Keep in sync with flake.nix packages.*-image.
#   closure = the build output is a nix2container recipe; size = `nix path-info -S`.
# (All images are n2c now; the `tarball` kind was retired with sandbox-os's n2c
# conversion — kept as a recognized value so an explicit entry wouldn't error.)
# EVERY shipped image. Keep in sync with .github/workflows/publish-images.yml's matrix —
# ci.yml's image-coverage check fails when they diverge, because an image measured but never
# published (or vice versa) is exactly how four controllers ended up with zero ghcr tags.
declare -A KIND=(
  [sandbox-os-image]=closure
  [agent-host-image]=closure
  [broker-image]=closure
  [webhooks-image]=closure
  [ui-image]=closure
  [scheduler-image]=closure
  [byoc-controller-image]=closure
  [conversation-controller-image]=closure
  [conversation-router-image]=closure
  [warm-store-controller-image]=closure
  # Published but not module-referenced: the claude-baked agent-host variant, and the
  # remote-agent image users `docker run` on their own machines (the one image whose size
  # people actually feel, on a laptop download).
  [agent-host-image-claude]=closure
  [remote-agent-image]=closure
)

# Default to all images (stable order); allow a subset via argv.
if [ "$#" -gt 0 ]; then
  IMAGES=("$@")
else
  IMAGES=(
    sandbox-os-image agent-host-image broker-image webhooks-image ui-image scheduler-image
    byoc-controller-image conversation-controller-image conversation-router-image
    warm-store-controller-image agent-host-image-claude remote-agent-image
  )
fi

measure_one() {
  local attr="$1" kind="${KIND[$1]:-}"
  if [ -z "$kind" ]; then
    echo "image-sizes: unknown image '$attr' (not in KIND map)" >&2
    return 1
  fi
  echo "==> building .#$attr ($kind)" >&2
  # The claude-baked images (agent-host-image-claude, remote-agent-image) contain the unfree
  # `claude` CLI, so they need NIXPKGS_ALLOW_UNFREE + --impure — exactly what
  # publish-images.yml already does per matrix entry. Without it the benchmark fails on
  # those two while every other image builds fine.
  local impure=()
  case "$attr" in
    *-claude|remote-agent-image) export NIXPKGS_ALLOW_UNFREE=1; impure=(--impure) ;;
  esac
  # `nix build --print-out-paths` prints the store path on stdout and build logs on
  # stderr, so capturing stdout gives exactly the out path (logs flow to our stderr).
  local out
  out=$(nix build "${impure[@]}" ".#$attr" --no-link --print-out-paths --print-build-logs)

  local bytes
  case "$kind" in
    tarball)
      # The .tar.gz IS the pushed image — measure the file.
      bytes=$(stat -c%s "$out")
      ;;
    closure)
      # nix2container: the recipe references the layer closure — measure it.
      bytes=$(nix path-info -S "$out" | awk '{print $2}')
      ;;
  esac
  printf '{"name":"%s","bytes":%s,"kind":"%s"}\n' "$attr" "$bytes" "$kind"
}

# Collect one JSON object per image, then fold into a sorted array.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
for attr in "${IMAGES[@]}"; do
  # SKIP, don't fail, an image the flake being measured does not have. The BASELINE run uses
  # this script against origin/main's flake, which legitimately predates any newly-added image
  # (all four controllers, on this very PR) — aborting there would fail the benchmark for the
  # exact change that adds an image. A missing image simply has no baseline to compare against.
  if ! measure_one "$attr" >> "$tmp"; then
    echo "image-sizes: skipping '$attr' (not in this flake — new image?)" >&2
  fi
done

jq -s 'sort_by(.name)' "$tmp"
