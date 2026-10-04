#!/usr/bin/env bash
# `bash -n` every script in .github/scripts/. Seconds, no cluster, no network.
#
# WHY this is worth a check of its own. These scripts are only ever executed by
# a CI job that first spends minutes standing up k3d and rolling out the
# platform, so a plain syntax error is not reported until four minutes in — and
# the job it fails is the expensive one. Nothing in the fast tier read these
# files at all.
#
# The error that prompted it: several scripts here hand a whole program to
# another shell as ONE single-quoted argument (`bash -c '<many lines>'`). A
# single quote added inside that program — innocuous-looking, e.g.
# `grep -qE '^k3d-...([[:space:]]|$)'` — CLOSES the outer string, and the outer
# shell then reparses the rest with different meaning:
#
#     syntax error near unexpected token `('
#
# shellcheck does NOT catch this: it reports the block as SC2016 ("expressions
# don't expand in single quotes") and treats the contents as one opaque word.
# `bash -n` does catch it, because the broken quoting is a defect in the OUTER
# file's parse. Inside such a block use double quotes and escape `$` as `\$`.
set -euo pipefail

cd "$(dirname "$0")"

fail=0
checked=0
for f in *.sh; do
  checked=$((checked + 1))
  if ! bash -n "$f" 2>/tmp/shell-syntax.err; then
    {
      echo "::error file=.github/scripts/$f::does not parse:"
      sed 's/^/    /' /tmp/shell-syntax.err
      echo "    If the error points into a \`bash -c '...'\` block, a nested single"
      echo "    quote has closed it — use double quotes inside and escape \$ as \\\$."
    } >&2
    fail=1
  fi
done

[ "$fail" -eq 0 ] || { echo "shell syntax check FAILED" >&2; exit 1; }
echo "✅ $checked script(s) in .github/scripts/ parse"
