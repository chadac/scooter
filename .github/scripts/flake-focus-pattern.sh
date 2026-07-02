#!/usr/bin/env bash
# Extract the focused-flake test pattern from a PR description for the
# `flake-focus` CI job (see .github/workflows/ci.yml).
#
# The PR that fixes a flake declares which test to hammer with a line in its body:
#
#     flake-test: <playwright -g pattern>
#
# e.g.  flake-test: multi-turn re-render
#
# We emit `pattern=<...>` to $GITHUB_OUTPUT. If the `flake-check` label is set but
# no such line exists (or it's empty), we FAIL — a targeted check that ran nothing
# must not masquerade as green.
set -euo pipefail

body="${PR_BODY:-}"

# First `flake-test:` line; strip the key, surrounding whitespace, and any
# wrapping backticks/quotes so `flake-test: \`multi-turn\`` works too.
pattern="$(
  printf '%s\n' "$body" \
    | grep -iE '^[[:space:]]*flake-test:' \
    | head -n1 \
    | sed -E 's/^[[:space:]]*[Ff]lake-test:[[:space:]]*//; s/^[`"'"'"']+//; s/[`"'"'"']+[[:space:]]*$//; s/[[:space:]]+$//'
)"

if [[ -z "$pattern" ]]; then
  echo "::error::The 'flake-check' label is set but the PR description has no" \
       "'flake-test: <pattern>' line. Add e.g. 'flake-test: multi-turn re-render'" \
       "so the focused check knows which test to run 20×."
  exit 1
fi

echo "Focused flake pattern: '$pattern'"
echo "pattern=$pattern" >>"$GITHUB_OUTPUT"
