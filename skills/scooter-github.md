---
name: scooter-github
type: knowledge
version: 1.0.0
triggers:
- gh
- gh cli
- gh pr create
- gh pr
- gh issue
- open a pull request
- create a pull request
- submit a pull request
- open a pr
- create a pr
- submit a pr
- github api
- command not found gh
- react to a github comment
- react to a comment
- acknowledge a comment
- github reaction
- comment_id
- someone commented on the pr
- new comment on the pr
- react with eyes
---

# GitHub from a Scooter sandbox

**Applies when you are trying to use the `gh` CLI, to open/submit a pull request
or issue on GitHub, or to acknowledge a comment someone left you there. It is not
relevant to ordinary `git` work.**

## `gh` is not installed. Use `agent-broker` instead.

The GitHub CLI is **not present** in this sandbox. `gh pr create` fails with
`command not found`. Do not try to install it.

Instead call the GitHub REST API through `agent-broker`, which injects
credentials for you — you never see or handle a token:

```bash
# Open a pull request. NOTE: the broker PATH comes FIRST, then curl-style args.
agent-broker github/repos/OWNER/REPO/pulls \
  -X POST -H 'Content-Type: application/json' \
  -d '{"title":"Fix X","head":"my-branch","base":"main","body":"..."}'
```

```bash
# Open an issue.
agent-broker github/repos/OWNER/REPO/issues \
  -X POST -H 'Content-Type: application/json' \
  -d '{"title":"Something is broken","body":"..."}'
```

**The argument order is the usual mistake:**

```
right:  agent-broker github/repos/o/r/pulls -X POST -d '{...}'
wrong:  agent-broker -X POST github/repos/o/r/pulls -d '{...}'
```

This is not plain `curl` — the API path is a positional argument, not a
`-`-flagged URL.

## Someone commented? React 👀 FIRST, before you start working

A comment on a PR/issue you own is forwarded to you within seconds — but the
human who wrote it sees **nothing** until you post something back. Your reply is
often minutes away (you're mid-run, or the comment asks for real work), and in
that silence they cannot tell whether you got it at all. A reaction closes that
gap: it is one call, it lands immediately, and it does not add a comment to the
thread.

**So when a comment arrives, react 👀 as the first action of the turn** — before
reading the repo, before planning, before any of the work. Then do the task, then
reply with `github_comment`.

The forwarded message hands you the id to react to:

```
@chadac commented on PR #42 in chadac/scooter:
...
(comment_id: 2371885432 — react to THIS comment to acknowledge it)
```

Two endpoints, and **picking the wrong one 404s** — a PR timeline comment and a
comment anchored to a line of the diff live in different collections:

| What the comment is | Endpoint |
|---|---|
| A top-level comment on a PR or issue (the timeline) | `repos/O/R/issues/comments/<id>/reactions` |
| A **review** comment (anchored to a line of the diff) | `repos/O/R/pulls/comments/<id>/reactions` |

```bash
# acknowledge a PR/issue comment
agent-broker github/repos/OWNER/REPO/issues/comments/<comment_id>/reactions \
  -X POST -H 'Content-Type: application/json' -d '{"content":"eyes"}'

# acknowledge a line/review comment (note: pulls, not issues)
agent-broker github/repos/OWNER/REPO/pulls/comments/<comment_id>/reactions \
  -X POST -H 'Content-Type: application/json' -d '{"content":"eyes"}'
```

### `content` is a FIXED set — GitHub has no custom emoji

```
+1  -1  laugh  confused  heart  hooray  rocket  eyes
```

That's all of them. Anything else is a **422** — in particular
`white_check_mark`, the ✅ you'd send in Slack, **does not exist here**. Use
`rocket` for "shipped it" and `+1` for "ack, agreed".

Re-sending a reaction you already left returns **200** with the existing
reaction, not an error, so a duplicate ack is harmless. To take one back you need
its reaction id: `DELETE repos/O/R/issues/comments/<id>/reactions/<reaction_id>`.

### A vocabulary worth keeping consistent

| | When |
|---|---|
| 👀 `eyes` | Received it, starting work. **The default ack.** |
| 🚀 `rocket` | Done — the fix is pushed / the PR is updated. |
| 👍 `+1` | Acknowledged, agreed, nothing further needed from you. |
| 😕 `confused` | You read it but genuinely don't understand the ask — **always** pair this with a comment asking what they meant. |

### Don't

- **A reaction is not a reply.** 👀 says "seen"; it never answers a question,
  and it never satisfies a request for a change. If the comment asked for
  something, the reaction is the *opening*, not the response.
- **Don't react to a backlog.** When you're catching up on a thread with several
  comments, react to the one addressed to you — not to every message in it.
- Don't react to your own comments (they come from the same bot identity you
  post as; it reads as talking to yourself).

### If you don't have the `comment_id`

When you arrived at the PR some other way, list the recent comments and pick the
one you mean:

```bash
agent-broker "github/repos/OWNER/REPO/issues/42/comments?per_page=100" \
  | jq -r '.[-5:][] | "\(.id)\t\(.user.login)\t\(.body[0:60])"'
# review (line) comments live in a different collection:
agent-broker "github/repos/OWNER/REPO/pulls/42/comments?per_page=100" \
  | jq -r '.[-5:][] | "\(.id)\t\(.user.login)\t\(.path)\t\(.body[0:50])"'
```

## Pushing a branch works normally

`git push` needs no special handling. `credential.helper` is preconfigured to
the broker (see `scooter-links`), so pushing a branch is ordinary git:

```bash
git checkout -b my-branch
git commit -am "..."
git push -u origin my-branch
```

**Push first, then open the PR** — the `head` branch must exist on the remote
before the API call.

## Anything created via the broker is auto-linked

A PR or issue you create through `agent-broker github/...` is automatically
attached to this conversation, so it shows in the UI's linked resources. If you
create one some other way, attach it yourself:

```bash
agent-broker link add https://github.com/OWNER/REPO/pull/42 --title "Fix X"
```

See `scooter-links` for the full linking story.

## Checking CI on your PR

You are not finished when the PR opens — you are finished when its checks pass.
Poll the same way:

```bash
# combined status for the PR's head commit
agent-broker github/repos/OWNER/REPO/commits/SHA/check-runs
```

Read the failing run's output, fix the cause, push, and check again.
