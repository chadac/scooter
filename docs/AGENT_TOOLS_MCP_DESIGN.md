# Design: agent-tools MCP server (slack_respond, gitlab/github_comment, web_search, web_fetch)

## Goal + the bug it fixes

Give the agent **typed, reliable tools** for the things it does constantly —
respond in a Slack thread, comment on a GitLab MR / GitHub PR, search the web,
fetch a URL — instead of the current "hand-run a `curl` from the sandbox" prompts.

**Root cause of the duplicate-Slack bug (#1):** the agent is instructed
(`services/webhooks/webhooks/handlers/slack.py:114-127`) to run:
```
curl -sf -X POST "$BROKER_URL/slack/chat.postMessage" -d '{"channel":...,"thread_ts":...,"text":...}'
```
- `curl -sf` **fails silently on any HTTP error** (the `-f`), and the agent then
  RETRIES → duplicate posts.
- Slack returns HTTP 200 with `{"ok":false,"error":"..."}` on logical failures —
  `curl -sf` treats that as success, so the agent can't tell.
- The "ack first, then respond" workflow means ≥2 posts by design.
Together → the observed duplicate Slack messages.

## Hard requirement (from the user): errors are NEVER hidden

The MCP tool is a **thin typed wrapper over the SAME broker call** the agent could
make by hand. It MUST echo the broker/upstream error faithfully — including
Slack's `{ok:false, error}` and any non-2xx from the broker — as an MCP
`isError: true` result carrying the real status + body. The abstraction adds
typing + inferred defaults + reliable success/failure detection; it must NOT
swallow, rewrite, or generic-ify errors. Whether the agent uses the tool or the
raw broker endpoint, it sees the same underlying error.

## Placement (decided)

Agent-host in-process, exactly like `modify_environment`
(`services/agent-host/src/agent/mcpServer.ts`): a per-conversation MCP endpoint
(`?conv=<id>`), stateless StreamableHTTP, registered on `newSession`. This is the
right home because:
- The **inferred defaults come from the conversation's context** the agent-host
  already owns — a conversation's links (`store.listLinks(convId)` →
  `{source:"slack", resourceType:"thread", ...}`) carry the channel/thread_ts, MR
  iid, PR number, repo. The agent supplies only the message text.
- The agent-host reaches the broker in-cluster (same as the sandbox does) and
  holds the conversation's identity, so the broker's per-conversation auth works.
- No new in-pod surface; the agent calls tools through the brain (like
  modify_environment), not by shelling out.

## The tools

All five register alongside `modify_environment` in `buildServer(...)`. Each
returns a clean success text OR `isError:true` with the real upstream error.

### 1. `slack_respond(text, thread_ts?)`
- Infer `channel` + `thread_ts` from the conversation's `slack`/`thread` link
  (the webhooks handler records it; see below — we need the channel+ts stored on
  the link, currently only in the Slack status message). Agent passes `text`.
- Calls the broker `POST /slack/chat.postMessage` with the inferred channel +
  thread_ts + text. Parses the Slack response: `ok:true` → success (returns the
  message ts); `ok:false` → `isError:true` with Slack's `error` string. A non-2xx
  from the broker → `isError:true` with status + body. NO silent failure, NO
  retry (the agent decides, seeing the real error).

### 2. `gitlab_comment(body, discussion_id?)`
- Infer project + MR iid (+ optional discussion to reply to) from the
  conversation's `gitlab`/`merge_request` link.
- Calls broker `POST /gitlab/projects/{id}/merge_requests/{iid}/notes` (or the
  discussions endpoint for a reply). Echoes GitLab's error faithfully.

### 3. `github_comment(body, in_reply_to?)`
- Infer owner/repo + PR/issue number from the conversation's `github` link.
- Calls broker `POST /github/repos/{o}/{r}/issues/{n}/comments` (or the PR-review
  reply endpoint). Echoes GitHub's error.

### 4. `web_search(query)`
- Not conversation-context-dependent — a generic capability the setup is missing.
- **Backend: DuckDuckGo Instant Answer API** (`https://api.duckduckgo.com/?q=<q>&format=json&no_html=1`)
  — FREE, NO API KEY, so no new secret and it can run straight from the agent-host
  (no broker provider needed). Returns a compact result from the DDG JSON:
  the `AbstractText`/`Heading` + `RelatedTopics` [{text, url}]. CAVEAT: DDG's IA
  API is instant-answers (definitions, abstracts, related topics), NOT a full web
  index — good enough for the missing capability, swappable later (the tool shape
  stays; only the backend fn changes) if we need richer results. Upstream errors
  echoed.

### 5. `web_fetch(url)`
- Fetch a URL and return its main text content (readerized/truncated). Guardrails:
  timeout, max size, block internal/metadata IPs (SSRF — the agent-host is
  in-cluster; MUST refuse RFC1918 / link-local / cloud-metadata addresses).
  Errors (timeout, non-2xx, blocked host) echoed as isError.

## Shared error-echo helper (the load-bearing piece)

One helper both the Slack/GitLab/GitHub tools use: `brokerCall(convId, method,
path, body) -> { ok, status, data, raw }`, which POSTs to the broker with the
conversation's auth, and a mapper `toToolResult(providerResult)` that turns a
non-ok broker/upstream response into `isError:true` with `status: <n>` +
`error: <upstream body/message>` VERBATIM. Slack's `{ok:false}` is detected and
mapped the same way (200-with-logical-error → isError). This is the single place
the "never hide an error" rule is enforced.

## The gap to close: inferred defaults need the context ON the link

Today `push_link(source="slack", resourceType="thread", title=...)` is called
WITHOUT the channel/thread_ts as structured fields (they're only in the human
title / the Slack status message). Same for GitLab/GitHub (the link has a `url`
but not the structured {project, iid} / {owner, repo, number}). For
`slack_respond` etc. to infer defaults, the link must carry the structured
identifiers.

**Fix:** extend `ConversationLink` with an optional `ref` object (e.g.
`{channel, threadTs}` / `{projectId, mrIid}` / `{owner, repo, number}`), and have
the webhooks handlers populate it in `push_link`. The MCP tool reads
`store.listLinks(convId)`, finds the matching source, and uses `ref`. (Backfill:
if `ref` is absent, the tool returns a clear isError telling the agent to pass the
target explicitly — no silent guess.)

## Replacing the curl prompts — FULL migration (user: "cover curl as well")

The MCP tools become the CANONICAL way the agent interacts with these services;
migrate EVERY raw-broker/curl response-instruction across the webhooks handlers,
not just Slack:
- `slack.py:_response_instructions` (108-127) — the explicit `curl -sf
  $BROKER_URL/slack/chat.postMessage` recipe → "use `slack_respond`". Drop the
  `-sf` curl entirely.
- `github.py:64` "post an acknowledgment on GitHub …" workflow → "use
  `github_comment`".
- `gitlab.py:101` "post an acknowledgment on GitLab …" → "use `gitlab_comment`".
- `jira.py:70` "post an acknowledgment on Jira …" → NO `jira_comment` tool in this
  first cut (Jira wasn't in the tool set). FOLLOW-UP: add `jira_comment` (same
  pattern) and migrate this prompt then; until then leave Jira's instruction as-is
  and note it.
Keep a one-line note in the migrated prompts that the raw broker endpoint still
exists and returns the SAME errors (nothing is lost; the tool is the reliable
path).

## Staging (PoC process)

1. **Research** — this doc. Open questions below.
2. **Design (boilerplate)** — signatures: the tool registrations, `brokerCall` +
   `toToolResult`, the `ConversationLink.ref` extension, the context-inference
   helper. No bodies.
3. **Tests (red-first)** — Tier-1 contract tests: each tool maps a successful
   broker response to a success result AND an upstream error (incl. Slack
   `{ok:false}` and a broker non-2xx) to `isError` with the REAL error echoed;
   context inference reads the link `ref`; web_fetch refuses an internal IP.
4. **Review** — you confirm the tool signatures, the error-echo shape, and the
   web_search backend before implementation.
5. **Implementation** — one PR; also flip the webhooks prompts off curl.

## Open questions (Research → Design gate)

- **Q1 (web_search backend) — RESOLVED:** DuckDuckGo Instant Answer API (free, no
  key) straight from the agent-host. Instant-answers only (not full web results);
  swappable later behind the same tool shape.
- **Q2 (web_fetch SSRF policy):** confirm the block-list (RFC1918, 127/8,
  169.254/16 incl. cloud metadata, ::1, .cluster.local). The agent-host is
  in-cluster — this MUST be strict, or the agent can read cluster-internal
  services / the node metadata endpoint.
- **Q3 (link ref migration):** existing conversations have links WITHOUT `ref`.
  The tool's fallback (isError asking for an explicit target) is safe; confirm
  that's acceptable vs. parsing the target out of the link `url` as a backup.
- **Q4 (reply vs new comment):** for gitlab/github, default to a NEW top-level
  comment, with an optional `in_reply_to`/`discussion_id` to thread a reply?
  (Proposed: yes — new comment by default, reply when the id is given.)
- **Q5 (broker web_search/fetch):** should web_search/web_fetch go through the
  broker at all (they need no per-conversation identity), or run straight from the
  agent-host? (Leaning: agent-host-direct for fetch; broker-provider for search if
  the key should be centrally held.)
