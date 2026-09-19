#!/usr/bin/env bash
# sticky-comment.sh — post a PR comment, or UPDATE the one this job posted before.
#
# Identity is the hidden HTML marker the body carries: we look for an existing
# comment containing it and PATCH that, so a re-run replaces its verdict instead
# of stacking a second one (a flake-focus PR is re-run repeatedly by design, and
# a column of stale "still reproduces" comments buries the current answer).
#
# Usage: sticky-comment.sh <marker> <body.md>
#   env: GH_TOKEN, GITHUB_REPOSITORY, PR (the pull request number)
set -euo pipefail

MARKER="${1:?usage: sticky-comment.sh <marker> <body.md>}"
BODY="${2:?usage: sticky-comment.sh <marker> <body.md>}"
: "${PR:?PR (pull request number) must be set}"

grep -qF "$MARKER" "$BODY" || {
  echo "::error::sticky-comment: body $BODY does not contain the marker '$MARKER'" \
       "— a later run could not find it to update, and would post a duplicate."
  exit 1
}

# REST, not `gh pr view`: we need the numeric comment id to PATCH (gh returns
# GraphQL node ids). --paginate because the marker may be on an older page.
id=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" --paginate \
       --jq ".[] | select(.body | contains(\"$MARKER\")) | .id" | tail -n1)

if [ -n "$id" ]; then
  gh api "repos/${GITHUB_REPOSITORY}/issues/comments/${id}" -X PATCH -F body=@"$BODY" >/dev/null
  echo "updated sticky comment ${id}"
else
  gh api "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" -F body=@"$BODY" >/dev/null
  echo "created sticky comment"
fi
