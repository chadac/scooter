---
name: agent-tools
type: knowledge
version: 1.0.0
triggers:
- respond in slack
- reply in slack
- slack_respond
- react in slack
- slack_react
- emoji reaction
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
- tool not available
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

**Names:** call each tool by the name it shows in **your own tool list** — that is
the authoritative name. The descriptions below identify tools by PURPOSE, not by an
exact string to type: match the purpose to the tool in your list and call THAT. If a
call comes back empty or a tool seems missing, re-check your tool list and use the
matching tool — a tool returning nothing does NOT mean "the tools are gone," and it
is NEVER a reason to fall back to raw `curl`/shell for something a tool does. Most of
all **Slack**: a raw post lands in the wrong (root) channel because it doesn't carry
the thread context the Slack tool sets for you.

## Responding where the request came from

When you were triggered by a Slack thread / GitHub PR / GitLab MR / Jira issue,
the target is **already known** — you only supply the message body. The tools for
this (by purpose — find them in your tool list):

- **Respond in the Slack thread** — post a message to the current Slack thread.
  The channel + thread are already known; you only provide the text. Use this to
  acknowledge and to reply. (Do not hand-build a Slack `chat.postMessage` — this
  tool targets the correct thread; a raw call can leak to the whole channel.)
- **React to the Slack message** — add an emoji reaction to a SPECIFIC Slack
  message. Pass `message_ts` (required) — the timestamp shown in the Slack
  notification as `message_ts: …` — so the reaction lands on that exact message
  (not the thread root). Emoji name WITHOUT colons, e.g. `"eyes"`,
  `"white_check_mark"`, `"tada"`. A quick 👀 to acknowledge or a ✅ when done —
  cheaper than a reply. Don't spam it.
- **Get the Slack thread context** — returns the Slack channel + `thread_ts` this
  conversation is attached to. You rarely need it (the respond/react tools already
  know), but use it when you need the raw ids — e.g. to build a permalink.
- **Comment on the GitHub PR/issue** — comment on the PR/issue this conversation
  came from. (Optional reply-to a review-comment id to reply inside a review thread.)
- **Comment on the GitLab MR** — comment on the MR this conversation came from.
  (Optional discussion id to reply inside a review discussion.)
- **Comment on the Jira issue** — comment on the Jira issue this conversation came from.

**These provider tools appear ONLY when that resource is attached** to this
conversation. If there's no Slack reply tool in your tool list, this conversation
is **not** attached to a Slack thread — do NOT try to reach Slack by another route
(a raw `curl` to the broker leaks to the whole channel). Same for github / gitlab /
jira: no comment tool for a provider ⇒ nothing of that kind is attached to comment
on. Match the tool to your live tool list, not to this doc — the doc lists what's
*possible*, your tool list shows what's *attached right now*.

Typical flow: **acknowledge first** (a short "on it" via the matching tool), do the
work, then post your result with the same tool. One acknowledgment, one result —
don't repeat.

## Looking things up

- **Search the web** — DuckDuckGo instant answers (definitions, abstracts, related
  links). Good for a quick fact or to find a canonical URL to fetch.
- **Fetch a URL** — fetch a public web page and get its readable text. Use it on a
  URL from a search result, a PR/issue link, or docs. (It refuses
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
api.github.com) and **`$BROKER_URL/gitlab/...`** (paths under gitlab.com — use the
FULL API path, e.g. `$BROKER_URL/gitlab/api/v4/projects/123/merge_requests`, just
as you would against GitLab directly). Each provider proxy is transparent: the
path after `/<provider>/` is exactly the upstream API path.
To *comment* on the resource this conversation came from, still prefer the
Jira / GitHub / GitLab comment tools — they infer the target for you. Use the raw
broker proxy for everything else.

**Slack is the exception — never post to Slack via the raw broker proxy.** Always
use the **Respond in the Slack thread** tool. A hand-built `chat.postMessage`
omits the `thread_ts`, so your message lands in the **root channel** (visible to
everyone) instead of the thread — a real incident, not a cosmetic bug. The tool
carries the thread context for you. If it seems unavailable, re-check your tool
list and use the Slack reply tool there — do not curl Slack.

## When to still use the shell

The shell is for **doing work in your sandbox** — running code, tests, git, build
tools, reading/writing files in the workspace. Use it freely there. Just don't use
it to *respond to people or reach external services* when a tool above already does
that reliably. For provider APIs beyond a comment, use the broker proxy shape
above rather than hunting for credentials.

## Subagents (delegating work)

You can delegate an independent task to a **subagent** — a second agent that
shares this conversation's sandbox (same `/workspace` + credentials) and runs in
the background:

- **spawn_subagent(prompt, title?)** — start one; returns a subagent id. After
  spawning, **END YOUR TURN** (or do other work). Do NOT sit in a `check_subagent`
  loop — you'll be nudged AUTOMATICALLY with the subagent's result the moment it
  finishes. Its final message is its result.
- **check_subagent / list_subagents / cancel_subagent** — check in ONCE, list, or
  stop. If a check shows it's still running, end your turn — don't poll.

**If a tool call is denied with a "Pause…" / "higher-priority work is waiting"
message: that is NOT an error and you did nothing wrong.** It means a subagent
just finished (or a message arrived) and its result is queued for you. Simply
**end your turn** — you'll receive the pending item on your next turn. Do not
retry the tool, apologize, or work around it.
