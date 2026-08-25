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
---

# GitHub from a Scooter sandbox

**Applies when you are trying to use the `gh` CLI, or to open/submit a pull
request or issue on GitHub. It is not relevant to ordinary `git` work.**

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
