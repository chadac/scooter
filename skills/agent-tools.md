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
- query jira
- jira issue
- jql
- transition jira
- broker endpoint
- broker api
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

## Beyond a comment: the broker proxy (Jira, GitHub, GitLab APIs)

The `*_comment` tools only *comment on the triggering resource*. For any OTHER
provider API work — query a Jira issue, run a JQL search, transition a ticket,
read a PR's files, list MRs — go through the **broker proxy**, which is already
configured in your sandbox. You do NOT need to find tokens, cloud ids, or base
URLs; the broker injects them. Don't rediscover this each time — it's fixed:

```
$BROKER_URL/<provider>/<the provider's own API path>
```
authenticated with a Bearer token read from `$BROKER_TOKEN_PATH`. Both env vars
are always set in your sandbox.

**Jira** (Atlassian Cloud REST v2/v3 — the broker maps `/jira/*` onto your site's
`/ex/jira/<cloud-id>/*`, so you just use the normal Jira REST paths):

```bash
TOKEN=$(cat "$BROKER_TOKEN_PATH")
# Read an issue:
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BROKER_URL/jira/rest/api/2/issue/ENG-123"
# JQL search:
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BROKER_URL/jira/rest/api/2/search?jql=project=ENG+AND+status=Open"
# Transition an issue (POST):
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BROKER_URL/jira/rest/api/2/issue/ENG-123/transitions" \
  -d '{"transition":{"id":"31"}}'
```

The same shape works for **`$BROKER_URL/github/...`** (paths under
api.github.com) and **`$BROKER_URL/gitlab/...`** (paths under gitlab.com/api/v4).
To *comment* on the resource this conversation came from, still prefer the
`jira_comment` / `github_comment` / `gitlab_comment` tools — they infer the
target for you. Use the raw broker proxy for everything else.

## When to still use the shell

The shell is for **doing work in your sandbox** — running code, tests, git, build
tools, reading/writing files in the workspace. Use it freely there. Just don't use
it to *respond to people or reach external services* when a tool above already does
that reliably. For provider APIs beyond a comment, use the broker proxy shape
above rather than hunting for credentials.
