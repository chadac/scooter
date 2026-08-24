#!/usr/bin/env bash
# check-image-coverage.sh — every image a MODULE tells a deploy to pull must actually be
# published, and every shipped image must be size-benchmarked.
#
# WHY THIS EXISTS. modules/*.nix default each component's image to
# "${registryPrefix}<name>", so a ghcr-based deploy pulls exactly those names. Four of them —
# byoc-controller, conversation-controller, conversation-router, warm-store-controller — were
# built by the flake, referenced by the modules, and NEVER in the publish matrix: zero ghcr
# tags, ImagePullBackOff for anyone not using a local registry. The remote-agent image had the
# same gap earlier. Nothing failed, because nothing compared the two lists.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { echo "  - $1"; fail=1; }

# What the modules tell deploys to pull (the registryPrefix defaults).
mapfile -t referenced < <(
  grep -rhoE '\$\{cfg\.registryPrefix\}[a-z-]+' modules/*.nix \
    | sed 's/${cfg.registryPrefix}//' | sort -u
)
# What CI publishes to ghcr.
mapfile -t published < <(
  grep -oE '\{ image: [a-z-]+' .github/workflows/publish-images.yml \
    | sed 's/{ image: //' | sort -u
)
# What the size benchmark measures (flake attrs, so map to image names via the matrix).
# The KIND map's keys are flake ATTRS (agent-host-image, agent-host-image-claude), so compare
# on attrs directly — stripping a "-image" suffix breaks on names like agent-host-image-claude
# where it is in the middle.
mapfile -t benchmarked < <(
  grep -oE '^\s+\[[a-z-]+\]=' scripts/image-sizes.sh | tr -d ' []=' | sort -u
)

echo "referenced by modules: ${#referenced[@]} | published: ${#published[@]} | benchmarked: ${#benchmarked[@]}"

echo "modules reference an image that is never published:"
for r in "${referenced[@]}"; do
  # agent-sandbox-os is the sandbox image; it publishes under that exact name.
  printf '%s\n' "${published[@]}" | grep -qx "$r" || note "$r (add it to publish-images.yml's matrix)"
done
[ "$fail" = 0 ] && echo "  (none)"

# The benchmark keys off flake attrs whose names differ from image names (ui-image ->
# agent-sandbox-ui), so compare on the ATTR side: every published image must have an attr in
# the KIND map, checked by name-mapping the matrix.
echo "published images missing from the size benchmark:"
missing_bench=0
while read -r img attr; do
  printf '%s\n' "${benchmarked[@]}" | grep -qx "$attr" || {
    echo "  - $img (attr $attr not in scripts/image-sizes.sh KIND map)"; missing_bench=1; fail=1
  }
done < <(grep -oE '\{ image: [a-z-]+, attr: [a-z-]+' .github/workflows/publish-images.yml \
          | sed 's/{ image: //;s/, attr:/ /')
[ "$missing_bench" = 0 ] && echo "  (none)"

# Every published image must ALSO have a content-tagged ref in ghcrImages, or the production
# render (platform-manifests-ghcr) falls back to that component's module default — `:latest`.
# A manifest that advertises pinned images while shipping four components unpinned is worse
# than one that never claimed to pin: no reproducibility, and a pod roll every deploy.
# Every published image must also be in the MANIFEST job, or its per-arch tags are pushed and
# never joined — the shared tag would keep pointing at whatever was there before, so aarch64
# users silently keep getting an x86 image.
echo "published images missing from the multi-arch manifest job:"
mapfile -t manifested < <(
  awk '/^  manifest:/,0' .github/workflows/publish-images.yml \
    | grep -oE '\{ image: [a-z-]+' | sed 's/{ image: //' | sort -u
)
missing_manifest=0
for img in "${published[@]}"; do
  printf '%s\n' "${manifested[@]}" | grep -qx "$img" || {
    echo "  - $img (add it to the manifest job's matrix)"; missing_manifest=1; fail=1
  }
done
[ "$missing_manifest" = 0 ] && echo "  (none)"

echo "published images missing a ghcrImages content-tag ref:"
missing_ref=0
refs_json=$(nix build .#ghcr-image-refs --no-link --print-out-paths 2>/dev/null)
if [ -n "$refs_json" ] && [ -f "$refs_json" ]; then
  for img in "${published[@]}"; do
    # agent-host-claude and remote-agent are deliberately outside ghcrImages: the claude
    # variant is split out for the unfree eval (ghcrImageClaude), and remote-agent is run by
    # USERS on their laptops, never referenced by a cluster manifest.
    case "$img" in agent-host-claude|remote-agent) continue ;; esac
    grep -q "/${img}:" "$refs_json" || {
      echo "  - $img (add it to ghcrImages in flake.nix, else the ghcr render uses :latest)"
      missing_ref=1; fail=1
    }
  done
  [ "$missing_ref" = 0 ] && echo "  (none)"
else
  echo "  (skipped — could not build .#ghcr-image-refs)"
fi

exit "$fail"
