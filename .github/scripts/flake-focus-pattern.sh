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
# OPTIONAL — some flakes only reproduce under CROSS-SPEC CONTENTION (the flaky
# test running interleaved with OTHER specs' load), so a lone `-g <test>` run
# never triggers them. Such a PR ALSO declares the spec files to run together:
#
#     flake-specs: test/e2e/sessions.spec.ts test/e2e/chat-search-filter.spec.ts
#
# When present, the focused job runs exactly those spec files (each test 5×)
# instead of the whole suite filtered to the pattern — recreating the contention
# that surfaces the flake. When absent, only the `-g <pattern>` path runs.
#
# We emit `pattern=<...>` and `specs=<...>` to $GITHUB_OUTPUT. If the
# `flake-check` label is set but no `flake-test:` line exists (or it's empty), we
# FAIL — a targeted check that ran nothing must not masquerade as green.
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

# Optional `flake-specs:` line — a space-separated list of spec files to run
# together under contention. Sanitised to just `test/e2e/*.spec.ts` tokens so a
# malformed body can't inject arbitrary shell args into the run step.
specs_raw="$(
  printf '%s\n' "$body" \
    | grep -iE '^[[:space:]]*flake-specs:' \
    | head -n1 \
    | sed -E 's/^[[:space:]]*[Ff]lake-specs:[[:space:]]*//'
)"
specs=""
if [[ -n "$specs_raw" ]]; then
  for tok in $specs_raw; do
    tok="${tok#\`}"; tok="${tok%\`}"        # strip wrapping backticks
    if [[ "$tok" =~ ^test/e2e/[A-Za-z0-9._/-]+\.spec\.ts$ ]]; then
      specs="${specs:+$specs }$tok"
    else
      echo "::warning::ignoring non-spec flake-specs token: '$tok'"
    fi
  done
fi
echo "Focused flake specs: '${specs}'"
echo "specs=$specs" >>"$GITHUB_OUTPUT"
