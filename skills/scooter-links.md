---
name: scooter-links
type: knowledge
version: 1.0.0
triggers:
- open a pr
- opened a pr
- created a pr
- pull request
- merge request
- created an issue
- jira ticket
- link the pr
- attach a link
- associate with conversation
---

# Attaching PRs / MRs / issues to this conversation (scooter-links)

When you open a pull request, merge request, or issue for a task, it should be
**linked to this conversation** so the human can follow along from the chat. Most
of the time this happens **automatically** — you usually don't have to do
anything.

## Auto-linking (no effort needed)

Any GitHub / GitLab / Jira create call you make **through the broker** is linked
automatically. If you create a PR/MR/issue via `agent-broker` (or a tool that
proxies through it), the broker sees the created resource in the response and
attaches it to this conversation for you. That covers, e.g.:

```bash
# auto-linked — no extra step
agent-broker -X POST github/repos/OWNER/REPO/pulls \
  -H 'Content-Type: application/json' \
  -d '{"title":"Fix X","head":"my-branch","base":"main"}'
```

## When to link manually

Auto-linking only sees calls that go **through the broker's API proxy**. If you
create the resource another way — the `gh` / `glab` CLI, `git push` that opens a
PR via a server-side hook, or any path that doesn't proxy through
`agent-broker <provider>/...` — it **won't** be auto-linked. In that case attach
it yourself:

```bash
# after `gh pr create` prints the URL:
agent-broker link add https://github.com/OWNER/REPO/pull/42 --title "Fix X"

# jira ticket you filed via the Atlassian UI/CLI:
agent-broker link add https://acme.atlassian.net/browse/PROJ-123
```

`--source` (github/gitlab/jira) and `--type` (pr/mr/issue) are **inferred from
the URL** when they're obvious; pass them explicitly if inference fails (the
command will tell you). `--title` is optional but makes the link readable in the
UI.

## Check what's already linked

```bash
agent-broker link ls
```

## Rule of thumb

If you just created a PR/MR/issue and you're **not sure** it went through the
broker proxy, run `agent-broker link ls` — if it's not there, `link add` it. A
duplicate link is harmless; an unlinked PR the human can't find is not.
