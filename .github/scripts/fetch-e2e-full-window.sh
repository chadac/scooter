#!/usr/bin/env bash
# Download the last few `e2e-full-report` artifacts from runs of this workflow on
# the default branch — the window `flake-focus-full` reports a spec's recent
# nightly record against, and the same artifacts `e2e-full-collect` diffs on.
#
# Usage:  fetch-e2e-full-window.sh <dest-dir> [max-runs]
# Needs:  GH_TOKEN, DEFAULT_BRANCH, GITHUB_WORKFLOW; `gh` on PATH (the caller
#         supplies it — `gh` is in NEITHER the devshell nor the fleet runner
#         image, which is why this is a script and not an inline step).
#
# Writes <dest>/<run-id>/report.json and <dest>/<run-id>/label.
#
# FAILS LOUDLY if the listing itself fails. An earlier inline version wrapped it
# in `2>/dev/null || true`, which made a missing `gh` indistinguishable from an
# empty window: the step printed "0 run(s)", exited 0, and the comment silently
# lost its window. A missing TOOL and a missing ARTIFACT are different problems.
set -euo pipefail

dest="${1:?usage: fetch-e2e-full-window.sh <dest-dir> [max-runs]}"
want="${2:-5}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${DEFAULT_BRANCH:?DEFAULT_BRANCH is required}"

if ! command -v gh >/dev/null 2>&1; then
  echo "::warning::gh not on PATH — no nightly window (run this under 'nix shell nixpkgs#gh -c')"
  exit 0
fi

mkdir -p "$dest"

# Not `|| true`: a listing that errors is a real failure and must not read as
# "no runs". Only the per-run download below is allowed to miss.
if ! runs=$(gh run list --workflow "${GITHUB_WORKFLOW:?}" --branch "$DEFAULT_BRANCH" \
  --limit 20 --json databaseId,createdAt \
  --jq '.[] | "\(.databaseId) \(.createdAt)"'); then
  echo "::warning::gh run list failed — no nightly window this time"
  exit 0
fi

found=0
while read -r id created; do
  [ -n "${id:-}" ] || continue
  [ "$found" -ge "$want" ] && break
  # Skip ourselves: on a push to the default branch this run IS the newest.
  [ "${id}" = "${GITHUB_RUN_ID:-}" ] && continue
  # Walk back rather than taking the newest: the artifact expires (90d) and a
  # run that died before `merge reports` has none, so "most recent" is not
  # "has one". A miss here is expected and skipped.
  if gh run download "$id" --name e2e-full-report --dir "$dest/$id" 2>/dev/null; then
    found=$((found + 1))
    # The column label for this run. A date reads; a run id does not.
    printf '%s' "${created%T*}" | cut -c6- >"$dest/$id/label"
    echo "  window: run $id ($created)"
  fi
done <<<"$runs"

echo "nightly window: $found run(s)"
