# Webhooks — Design

> Service at `services/webhooks/` (Python/FastAPI, lifted from openhands-nix).
> Lets people spawn agent conversations from GitHub/GitLab/Jira/Slack threads.

## 1. Purpose

Inbound webhooks → spawn an agent. Someone comments `@agent fix this` (or labels
an issue) and a sandbox conversation starts working on it; status + results post
back to the originating thread.

## 2. What's reused vs. replaced (vs. openhands-nix)

The openhands-nix webhooks service splits cleanly:

- **Reused ~verbatim (provider-agnostic):**
  - `handlers/{github,gitlab,jira,slack}.py` — verify webhook signatures, detect
    the trigger (`@mention` / label), extract the task text + context.
  - `responses/{...}.py` — post status/results back to the thread (comment,
    Slack reply) via each provider's API.
  - `status_monitor.py` — poll running conversations, update the thread on status
    change.
- **Replaced:** `openhands_client.py` → **`agent_host_client.py`**. The only
  OpenHands-coupled piece. It spawned conversations via OpenHands' API; we spawn
  via the **agent-host's existing `POST /agui`** (the same path the UI uses).

## 3. The spawn seam — `POST /agui`

The agent-host already exposes the AG-UI HttpAgent protocol at `POST /agui`:
a `RunAgentInput {threadId, messages}` in, an SSE stream of AG-UI events out,
and it **find-or-starts** the conversation for that threadId
(`promptByThread`). So webhooks spawns an agent with no new agent-host API:

```
agent_host_client.create_conversation(task, repo, source) ->
  threadId = uuid()                      # webhooks owns the id
  POST {agent_host}/agui
    { threadId, messages: [{role: user, content: <task + context>}] }
  # consume the SSE stream:
  #   - RUN_STARTED  -> conversation is live
  #   - TEXT_MESSAGE_* / TOOL_CALL_* -> the agent working
  #   - RUN_FINISHED -> done; collect the final assistant message
  return { conversation_id: threadId, result: <final text> }
```

- **conversation_id = the threadId webhooks generated** → it's known up front, so
  the thread↔conversation mapping (in the shared store) is recorded immediately.
- **Result flows back via the SSE stream**: webhooks reads `/agui` server-side,
  accumulates the final assistant message, and posts it back through the
  matching `responses/` module. (No separate sandbox-message API like OpenHands
  had — the agent runs in the agent-host, reachable directly.)
- **Repo/context** are passed as part of the task text for now (the agent clones
  / works in its sandbox). A richer "selected_repository" affordance can come
  later if the agent-host grows one.

## 4. State (thread ↔ conversation)

The openhands-nix `common` lib (Postgres ORM + the ConversationMap/PendingMessage
tables) is reused for the thread↔conversation mapping and status tracking. For
the first cut this can be in-memory / SQLite; Postgres when multi-replica.

## 5. Flow (GitHub issue comment)

```
user: "@agent fix the bug in auth.py"  (GitHub issue #42)
  -> POST /webhooks/github  (HMAC-verified)
  -> handler: mention found -> task = "<context> + fix the bug in auth.py"
  -> agent_host_client.create_conversation(task, repo="o/r", source=github#42)
       POST {agent_host}/agui {threadId, messages:[task]}  -> stream -> result
  -> store: map github:issue:o/r#42 -> threadId
  -> responses/github: post the result as a comment on #42
  -> status_monitor tracks the conversation, edits the comment on status change
```

## 6. Layout (`services/webhooks/`)

```
services/webhooks/
  webhooks/
    app.py              FastAPI routes (/webhooks/{provider}, /health, relay)
    config.py
    agent_host_client.py  <- NEW: spawn via POST /agui + read the SSE result
    handlers/{github,gitlab,jira,slack}.py
    responses/{github,gitlab,jira,slack}.py
    status_monitor.py
  tests/
  default.nix  pyproject.toml
```

## 7. Open / deferred

- **Result streaming vs. one-shot:** v1 posts the final message when
  RUN_FINISHED. Live progress edits (like the UI) can come via status_monitor.
- **Auth:** the agent-host `/agui` is currently unauthenticated; webhooks → agent
  -host is in-cluster. Add a shared token if exposed.
- **kubenix:** a `modules/webhooks.nix` Deployment + Ingress (webhooks must be
  publicly reachable for providers to call) — post first cut.
- **A `test` webhook** (like the broker's whoami) for e2e: POST a fake event ->
  assert a conversation spawned -> result posted to a fake sink.
```
