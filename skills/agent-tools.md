---
name: agent-tools
type: knowledge
version: 1.0.0
triggers:
- respond in slack
- reply in slack
- slack_respond
- comment on the PR
- comment on the MR
- github_comment
- gitlab_comment
- comment on jira
- jira_comment
- web search
- web_search
- search the web
- fetch a url
- web_fetch
- read a web page
- acknowledge the request
- reply to the requester
---

# Your built-in tools — PREFER THESE over shell/curl

You have first-class **MCP tools** for the things you do constantly. **Always
prefer these tools over shelling out** (`curl`, `gh`, `glab`, the Jira API, etc.).
They are faster, they know the context so you don't have to pass it, and — most
importantly — they report the REAL result (a Slack `{ok:false}`, a GitHub 422, a
GitLab error) instead of failing silently the way `curl -sf` does. A silent curl
failure is exactly how you end up retrying and posting duplicate messages. Use the
tools.

If a tool ever returns an error, READ it and fix the cause — do NOT blindly retry
(that duplicates comments/messages). The tool tells you what actually went wrong.

## Responding where the request came from

When you were triggered by a Slack thread / GitHub PR / GitLab MR / Jira issue,
the target is **already known** — you only supply the message body:

- **`slack_respond(text)`** — post to the current Slack thread. (Optional
  `thread_ts` to override; you almost never need it.)
- **`github_comment(body)`** — comment on the PR/issue this conversation came from.
  (Optional `in_reply_to` — a review-comment id — to reply inside a PR review
  thread.)
- **`gitlab_comment(body)`** — comment on the MR this conversation came from.
  (Optional `discussion_id` to reply inside a review discussion.)
- **`jira_comment(body)`** — comment on the Jira issue this conversation came from.

Typical flow: **acknowledge first** (a short "on it" via the matching tool), do the
work, then post your result with the same tool. One acknowledgment, one result —
don't repeat.

## Looking things up

- **`web_search(query)`** — search the web (DuckDuckGo instant answers:
  definitions, abstracts, related links). Good for a quick fact or to find a
  canonical URL to fetch.
- **`web_fetch(url)`** — fetch a public web page and get its readable text. Use it
  on a URL from a search result, a PR/issue link, or docs. (It refuses
  internal/cluster/metadata addresses.)

## When to still use the shell

The shell is for **doing work in your sandbox** — running code, tests, git, build
tools, reading/writing files in the workspace. Use it freely there. Just don't use
it to *respond to people or reach external services* when a tool above already does
that reliably. The raw broker endpoints still exist and return the same errors, but
the tools are the reliable path — reach for them first.
