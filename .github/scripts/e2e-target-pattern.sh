#!/usr/bin/env bash
# Emits pattern= from a labelled PR's `e2e-target:` line, else empty.
set -euo pipefail

body="${PR_BODY:-}"
labels="${LABELS:-}"

# A queue entry carries no PR, so look it up.
if [[ "${GITHUB_EVENT_NAME:-}" == "merge_group" ]]; then
  if [[ ! "${MERGE_GROUP_HEAD_REF:-}" =~ /pr-([0-9]+)-[0-9a-f]+$ ]]; then
    echo "::warning::cannot find the PR number in '${MERGE_GROUP_HEAD_REF:-}'; no e2e-target"
    echo "pattern=" >>"$GITHUB_OUTPUT"
    exit 0
  fi
  pr="${BASH_REMATCH[1]}"
  json="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$pr")"
  body="$(jq -r '.body // ""' <<<"$json")"
  labels="$(jq -r '[.labels[].name] | join(",")' <<<"$json")"
fi

if [[ ",$labels," != *",e2e-target,"* ]]; then
  echo "pattern=" >>"$GITHUB_OUTPUT"
  exit 0
fi

# First `e2e-target:` value outside code fences, unquoted, CR stripped.
pattern="$(printf '%s\n' "$body" \
  | awk '/^[[:space:]]*(```|~~~)/ { fenced = !fenced; next } !fenced' \
  | { grep -iE '^[[:space:]]*e2e-target:' || true; } \
  | head -n1 \
  | sed -E "s/^[[:space:]]*[^:]+:[[:space:]]*//; s/^[\`\"']+//; s/[\`\"']+[[:space:]]*\$//; s/[[:space:]]+\$//")"

if [[ -z "$pattern" ]]; then
  echo "::error::The 'e2e-target' label is set but the PR description has no" \
       "'e2e-target: <pattern>' line outside a code block. Add one naming the new" \
       "e2e-full tests, e.g. 'e2e-target: renames a conversation|archives a conversation'."
  exit 1
fi

echo "e2e-target pattern: '$pattern'"
echo "pattern=$pattern" >>"$GITHUB_OUTPUT"
