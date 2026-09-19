#!/usr/bin/env bash
# sticky-comment.sh — post a PR comment, or UPDATE the one this job posted before.
#
# Identity is the hidden HTML marker the body carries: we look for an existing
# comment containing it and PATCH that, so a re-run replaces its verdict instead
# of stacking a second one (a flake-focus PR is re-run repeatedly by design, and
# a column of stale "still reproduces" comments buries the current answer).
#
# Usage:
#   sticky-comment.sh <marker> <body.md>                 # whole comment is ours
#   sticky-comment.sh <marker> <body.md> --section <id>  # we own one SECTION of it
#
# In --section mode the comment is SHARED: `flake focus` (fast) and `flake focus
# full` (k3d) each own a section of one comment, because the two verdicts only
# mean something read together. That makes the write read-modify-write, so two
# jobs finishing at once can clobber each other — hence the verify-and-retry
# below. See scripts/comment-sections.mjs.
#
#   env: GH_TOKEN, GITHUB_REPOSITORY, PR (the pull request number)
set -euo pipefail

MARKER="${1:?usage: sticky-comment.sh <marker> <body.md> [--section <id>]}"
BODY="${2:?usage: sticky-comment.sh <marker> <body.md> [--section <id>]}"
SECTION=""
if [ "${3:-}" = "--section" ]; then SECTION="${4:?--section needs an id}"; fi
: "${PR:?PR (pull request number) must be set}"

if [ -z "$SECTION" ]; then
  grep -qF "$MARKER" "$BODY" || {
    echo "::error::sticky-comment: body $BODY does not contain the marker '$MARKER'" \
         "— a later run could not find it to update, and would post a duplicate."
    exit 1
  }
fi

# REST, not `gh pr view`: we need the numeric comment id to PATCH (gh returns
# GraphQL node ids). --paginate because the marker may be on an older page.
find_id() {
  gh api "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" --paginate \
    --jq ".[] | select(.body | contains(\"$MARKER\")) | .id" | tail -n1
}

write_once() {
  local id merged=/tmp/sticky-merged.md
  id=$(find_id)

  if [ -n "$SECTION" ]; then
    # Merge our section into whatever is there NOW (another job may have written
    # since our last attempt), rather than overwriting the whole comment.
    if [ -n "$id" ]; then
      gh api "repos/${GITHUB_REPOSITORY}/issues/comments/${id}" --jq .body > /tmp/sticky-existing.md
    else
      : > /tmp/sticky-existing.md
    fi
    node scripts/comment-sections.mjs --section "$SECTION" \
      --new "$BODY" --existing /tmp/sticky-existing.md > "$merged"
  else
    cp "$BODY" "$merged"
  fi

  if [ -n "$id" ]; then
    gh api "repos/${GITHUB_REPOSITORY}/issues/comments/${id}" -X PATCH -F body=@"$merged" >/dev/null
    echo "updated sticky comment ${id}${SECTION:+ (section: $SECTION)}"
  else
    gh api "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" -F body=@"$merged" >/dev/null
    echo "created sticky comment${SECTION:+ (section: $SECTION)}"
  fi
}

# Whole-comment mode is last-write-wins by definition — one write, done.
if [ -z "$SECTION" ]; then write_once; exit 0; fi

# Section mode: verify our section survived, and re-apply if a racing job's write
# landed between our read and our write. Converges in one extra pass; three
# attempts is generous for two jobs.
for attempt in 1 2 3; do
  write_once
  sleep $(( attempt * 3 ))
  id=$(find_id)
  [ -n "$id" ] || continue
  gh api "repos/${GITHUB_REPOSITORY}/issues/comments/${id}" --jq .body > /tmp/sticky-check.md
  if node scripts/comment-sections.mjs --section "$SECTION" --new "$BODY" --check /tmp/sticky-check.md; then
    echo "section '$SECTION' verified in the shared comment"
    exit 0
  fi
  echo "::notice::section '$SECTION' was clobbered by a concurrent write — retrying ($attempt/3)"
done

# Don't fail the job over a comment: the verdict is also in the step summary, and
# the check's own pass/fail still stands.
echo "::warning::could not confirm the '$SECTION' section in the shared PR comment after 3 attempts"
