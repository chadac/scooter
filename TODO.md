# TODO

Running list of work items. Newest asks at the top of each section. See
`docs/DESIGN.md` / `docs/TESTING.md` for architecture and test tiers.

## In progress

- [ ] **Chat-window reliability — live SSE + integrity checksum.**
  Bug: a webhook-spawned (or other-tab) conversation's agent reply doesn't show
  in an open UI window until refresh. Root cause: the UI only uses the
  HttpAgent `POST /agui` (run-scoped — streams only runs *it* starts) + a
  one-shot `loadHistory` snapshot. It never subscribes to the persistent
  `GET /conversations/:id/events` SSE (which replays history AND stays open for
  live events).
  - [x] Rolling integrity checksum module + contract tests (`integrity.ts`,
        commit 857d49d). `checksum_n = sha256(checksum_{n-1} || canonical(event_n))`.
  - [ ] Server: store becomes checksum authority; expose checksum on history +
        on the live `/events` stream (enriched envelope on the dedicated SSE,
        NOT on the @ag-ui events — the @ag-ui/client validates and would reject
        extra fields).
  - [ ] UI: subscribe to the live `/events` SSE for the selected conversation;
        track the rolling checksum; on a `prevChecksum` mismatch, refetch
        history until the chains agree (self-heal).

- [ ] **Durable webhooks mapping store (Postgres).**
  The PR/Slack ↔ conversation mapping (`ConversationMap`) is fully implemented
  but stored in SQLite on an **emptyDir** — wiped on every pod restart (Karpenter
  consolidated the pods twice in one day). A restart orphans every in-flight
  mapping: follow-up comments spawn a new conversation instead of resuming, and
  status-back-posting stops.
  - [x] Add `asyncpg` to webhooks deps (`pyproject.toml` + `default.nix`).
  - [ ] Add a Postgres Deployment + Service + PVC + creds Secret to
        `modules/webhooks.nix` (gated option); switch DSN to
        `postgresql+asyncpg://…` when enabled. (`init_db` runs `create_all`, so
        no migration tooling needed.)
  - [ ] Wire it in example-app `kubenix/agent-manager.nix` + apply.

## Backlog

- [ ] **Conversation titling is weak.** The first thing an agent does on a new
  conversation should be to assign a title (right now titles are derived from
  the first user message client-side, or stay "New chat"). Likely needs a new
  agent tool (e.g. `set_conversation_title`) that calls the agent-host
  management API (`setTitle`) so the agent — not just the UI heuristic — names
  the conversation meaningfully.

- [ ] **UI emptiness during agent-host restart.** For ~30–60s while the
  agent-host pod cycles (deploy, node consolidation), a fresh tab shows an empty
  sidebar (no server to fetch from). The localStorage cache softens it for an
  existing tab. A retry-with-backoff on the initial `loadConversations` would
  paper over it.

## External (provider config — outside the cluster)

- [ ] Point the **GitHub App** (id 3515015) webhook URL →
      `https://scooter.example.com/webhooks/github` (secret = github-app
      `webhook-secret`; events: issue_comment, issues, pull_request). Likely
      still points at the old OpenHands receiver.
- [ ] Point the **Slack app** Event Subscriptions URL →
      `https://scooter.example.com/webhooks/slack` (subscribe app_mention +
      message.channels). URL verification challenge already confirmed working.

## Done (recent)

- [x] Webhooks: GitHub + Slack providers wired, Traefik ingress at
      scooter.example.com, `!scooter` / `scooter` triggers (commit 3da8187,
      deployed + externally verified).
- [x] Session persistence: ordered history log, delete-don't-tombstone,
      localStorage + server hydrate, e2e coverage (commit c5d6508, deployed +
      live-verified).
- [x] Scooter authored a real PR (#203) end-to-end via the broker.
