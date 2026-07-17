#!/usr/bin/env bash
# image-sizes.sh — measure the on-disk size of every shipped container image and
# emit it as JSON, for the CI image-size benchmark (report + compare vs origin/main).
#
# Two image kinds, two honest measures of "how big is the thing we push":
#   * tarball images (sandbox-os*) build a single .tar.gz FILE — the pushed artifact
#     IS that file, so we measure its byte size directly.
#   * nix2container images (agent-host/broker/webhooks/ui) build a recipe *.json that
#     REFERENCES the store paths that become layers — the pushed bytes are that
#     closure, so we measure `nix path-info -S` (total closure size) of the recipe.
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
#   tarball  = the build output is a .tar.gz file; size = that file's bytes.
#   closure  = the build output is a nix2container recipe; size = `nix path-info -S`.
declare -A KIND=(
  [sandbox-os-image]=tarball
  [sandbox-os-overlay-image]=tarball
  [agent-host-image]=closure
  [broker-image]=closure
  [webhooks-image]=closure
  [ui-image]=closure
)

# Default to all images (stable order); allow a subset via argv.
if [ "$#" -gt 0 ]; then
  IMAGES=("$@")
else
  IMAGES=(sandbox-os-image sandbox-os-overlay-image agent-host-image broker-image webhooks-image ui-image)
fi

measure_one() {
  local attr="$1" kind="${KIND[$1]:-}"
  if [ -z "$kind" ]; then
    echo "image-sizes: unknown image '$attr' (not in KIND map)" >&2
    return 1
  fi
  echo "==> building .#$attr ($kind)" >&2
  # `nix build --print-out-paths` prints the store path on stdout and build logs on
  # stderr, so capturing stdout gives exactly the out path (logs flow to our stderr).
  local out
  out=$(nix build ".#$attr" --no-link --print-out-paths --print-build-logs)

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
  measure_one "$attr" >> "$tmp"
done

jq -s 'sort_by(.name)' "$tmp"
