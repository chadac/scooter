#!/usr/bin/env bash
# fails-first: a PR's newly-added `@proves` tests must FAIL without the PR's changes.
#
# A bugfix PR ships a fix and tests that prove it. The proof is only real if the
# tests are red on the code WITHOUT the fix — a test that passes on pristine base
# has zero discriminating power (that exact failure mode shipped once: UI tests
# that passed on unpatched main). This script automates the inject-verify ritual:
#
#   1. collect tests ADDED in this branch whose title carries `@proves`
#   2. run them on HEAD             -> every one must PASS  (green-on-head)
#   3. graft ONLY the test files onto a merge-base worktree and run them there
#                                   -> every one must FAIL  (red-on-base)
#
# A base-side failure that never reaches the assertion (the file doesn't compile
# because the PR adds the API it imports) is ACCEPTED but annotated "load-error":
# technically red, but weaker proof than an assertion failure — reviewers can tell
# the difference from the output.
#
# Marker contract: `@proves` must be on the same line as `it(`/`test(` and the
# title must be a single plain-quoted string (no template interpolation).
#
# Usage: test/support/fails-first.sh [base-ref]     (default origin/main)
set -euo pipefail

BASE="${1:-origin/main}"
HEAD_SHA=$(git rev-parse HEAD)
MB=$(git merge-base "$BASE" HEAD)
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

# ── 1. collect newly-added @proves tests ─────────────────────────────────────
# Parse the -U0 diff: track `+++ b/<file>` headers, match added `it(`/`test(`
# lines carrying @proves, extract the quoted title.
mapfile -t CLAIMS < <(git diff -U0 "$MB..$HEAD_SHA" -- '*.spec.ts' '*.test.ts' '*.spec.tsx' '*.test.tsx' \
  | python3 -c '
import re, sys
file = None
pat = re.compile(r"""(?:\bit|\btest)(?:\.\w+)?\(\s*(['"'"'"`])(.*?@proves.*?)\1""")
for line in sys.stdin:
    if line.startswith("+++ b/"):
        file = line[6:].strip()
    elif line.startswith("+") and not line.startswith("+++") and file:
        m = pat.search(line)
        if m:
            print(f"{file}\t{m.group(2)}")
')

if [ ${#CLAIMS[@]} -eq 0 ]; then
  echo "fails-first: no @proves tests added vs $BASE — nothing claimed, nothing to check."
  exit 0
fi
echo "fails-first: ${#CLAIMS[@]} claimed proof(s) vs $BASE (merge-base ${MB:0:8}):"
printf '  %s\n' "${CLAIMS[@]}"

# ── runner helpers ───────────────────────────────────────────────────────────
regex_escape() { python3 -c 'import re,sys; print(re.escape(sys.argv[1]))' "$1"; }

is_playwright() { case "$1" in test/e2e/*) return 0 ;; *) return 1 ;; esac; }

# run <dir> <file> <title>; echoes verdict: pass | fail | load-error
run_one() {
  local dir="$1" file="$2" title="$3" out rc pattern
  pattern=$(regex_escape "$title")
  out=$(mktemp)
  if is_playwright "$file"; then
    (cd "$dir" && npx playwright test --project=chromium "$file" --grep "$pattern") >"$out" 2>&1 && rc=0 || rc=$?
  else
    (cd "$dir" && npx vitest run "$file" -t "$pattern") >"$out" 2>&1 && rc=0 || rc=$?
  fi
  # "fail" means the named test RAN and asserted red. A file that cannot even load
  # shows up differently per runner: vitest prints "Test Files 1 failed" but its
  # "Tests" summary line shows no failed tests; playwright prints an error with no
  # "N failed" count line.
  if [ $rc -eq 0 ]; then
    echo pass
  elif is_playwright "$file" && grep -qE '^ *[0-9]+ failed' "$out"; then
    echo fail
  elif ! is_playwright "$file" && grep -qE '^ *Tests([^0-9]|.*[^s] )*[0-9]+ failed' "$out"; then
    echo fail
  else
    echo load-error
  fi
  rm -f "$out"
}

# Playwright boots the shared-port webServer stack (8080/5173/8090/5273). On a
# machine where those are already held (a dev server — possibly someone else's on
# a shared box) the run would either collide or silently reuse a server running
# DIFFERENT code. Refuse instead; never kill the ports.
if printf '%s\n' "${CLAIMS[@]}" | cut -f1 | grep -q '^test/e2e/' && [ "${E2E_REUSE_SERVER:-}" != "1" ]; then
  for p in 8080 5173 8090 5273; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      exec 3>&- || true
      echo "fails-first: port $p is busy — a playwright claim can't run against an unknown server." >&2
      echo "  Free the port (your own server only!) or rerun in CI." >&2
      exit 2
    fi
  done
fi

# ── 2. green-on-head ─────────────────────────────────────────────────────────
violations=0
declare -a REPORT
for c in "${CLAIMS[@]}"; do
  file="${c%%$'\t'*}"; title="${c#*$'\t'}"
  v=$(run_one "$ROOT" "$file" "$title")
  if [ "$v" != pass ]; then
    REPORT+=("HEAD  $v  $file :: $title   <-- must PASS with the fix")
    violations=$((violations + 1))
  else
    REPORT+=("HEAD  pass  $file :: $title")
  fi
done

# ── 3. red-on-base ───────────────────────────────────────────────────────────
WT="$ROOT/.fails-first-wt"
cleanup() { git worktree remove --force "$WT" 2>/dev/null || true; }
trap cleanup EXIT
cleanup
git worktree add --detach -q "$WT" "$MB"

# Graft HEAD's test surface (test files, fixtures, runner configs) — nothing else.
git -C "$WT" ls-tree -r --name-only "$HEAD_SHA" 2>/dev/null >/dev/null # ensure objects reachable
{
  git ls-tree -r --name-only "$HEAD_SHA" | grep -E '^test/|/tests?/|\.(spec|test)\.(ts|tsx|mts|mjs|js)$' || true
  git ls-tree --name-only "$HEAD_SHA" | grep -E '^(playwright|vitest)\.' || true
} | sort -u | (cd "$WT" && xargs -d '\n' -r git checkout "$HEAD_SHA" --)

# The worktree shares the main checkout's installed deps (node_modules are not in git).
find . -maxdepth 3 -type d -name node_modules -not -path '*/node_modules/*' | while read -r d; do
  rel="${d#./}"
  parent="$WT/$(dirname "$rel")"
  [ -d "$parent" ] && [ ! -e "$WT/$rel" ] && ln -s "$ROOT/$rel" "$WT/$rel"
done

# Workspace dists the test env needs (vitest load deps; playwright's webServer runs
# agent-host from dist). Built from BASE's source so the code-under-test is base's.
# Caveat: if the fix under proof lives in one of these packages' BUILD OUTPUT ONLY,
# a stale main-tree artifact can't leak in (we build fresh here), but a build
# failure downgrades those claims to load-error.
(cd "$WT" && npm run build \
  -w @kubenix-agent-manager/agent-host \
  -w @scooter/claude-sdk-provider \
  -w @scooter/marimo-mcp >/dev/null 2>&1) \
  || echo "fails-first: WARNING — base workspace build failed; dist-dependent claims will read load-error"

for c in "${CLAIMS[@]}"; do
  file="${c%%$'\t'*}"; title="${c#*$'\t'}"
  v=$(run_one "$WT" "$file" "$title")
  case "$v" in
    pass)
      REPORT+=("BASE  PASS  $file :: $title   <-- NO DISCRIMINATING POWER: passes without the fix")
      violations=$((violations + 1)) ;;
    fail)
      REPORT+=("BASE  fail  $file :: $title   (assertion-strength proof)") ;;
    load-error)
      REPORT+=("BASE  load-error  $file :: $title   (weak proof: file does not run on base)") ;;
  esac
done

echo
echo "fails-first report (HEAD must pass, BASE must not):"
printf '  %s\n' "${REPORT[@]}"
if [ "$violations" -gt 0 ]; then
  echo "fails-first: $violations violation(s)." >&2
  exit 1
fi
echo "fails-first: all claims hold."
