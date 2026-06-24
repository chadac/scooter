# TODO

Running list of work items. Newest asks at the top of each section. See
`docs/DESIGN.md` / `docs/TESTING.md` for architecture and test tiers.

## In progress

- [~] **Chat-window reliability — live SSE + integrity checksum.** SERVER DONE +
  CLIENT lib done; UI reconciliation works in isolation but is flaky in the
  shared-server e2e suite — needs a better render primitive before it lands.
  Bug: a webhook-spawned (or other-tab) conversation's agent reply doesn't show
  in an open UI window until refresh — the UI only streamed runs IT started.
  - [x] Rolling integrity checksum module + tests (`integrity.ts`, 857d49d).
  - [x] Server: store is the checksum authority (readEventsWithChecksum +
        onAppend, folded in write order); GET /history returns the checksum;
        new GET /conversations/:id/events.integrity replays + streams live with
        checksums (plain JSON SSE, not @ag-ui-encoded). 404 on unknown conv so
        the client stops reconnecting. (commits 77ef7f5, b712f20, 9cf97aa, 58c3844)
        + nginx /agui+/conversations made SSE-safe (no buffering). 45/45 Tier 1.
  - [x] integrityStream.ts client (subscribe, fold, checksum self-heal). VERIFIED
        live against the real stack: every event link_ok, message present.
  - [ ] **UI reconciliation is the open part.** Wiring the integrity stream into
        RuntimeProvider via full `runtime.thread.reset()` works in a single e2e
        run (the live-stream.spec test passes in isolation — the reported bug IS
        fixed) but FLAKES in the full shared-webServer suite: reset() per-update
        fights assistant-ui's own render, and each open page holds a long-lived
        SSE that stresses the single-process test server. NEXT: use assistant-ui's
        incremental `import()`/`append()` API instead of full reset(), so we
        apply deltas rather than rebuilding the thread each update. The
        RuntimeProvider + live-stream.spec + cleanState changes are left
        UNCOMMITTED pending that (server side is committed + solid).

- [x] **Durable webhooks mapping store (Postgres).** DONE — deployed + verified.
  The PR/Slack ↔ conversation mapping was SQLite on an emptyDir (wiped on every
  restart). Now a PVC-backed Postgres pod (`agent-webhooks-db`, ebs-gp3 1Gi);
  the app assembles the DSN from DB_* env (password via secretKeyRef). All 5
  tables created in Postgres, verified live. (commits c9eba33, mkMerge fix.)

## Backlog

- [ ] **ACP-expanding tools — agent-presented option dropdown.** Give the agent
  a tool to present a set of choices to the user as a dropdown/select in the UI,
  and block until the user picks. Maps to an ACP request → AG-UI custom event →
  assistant-ui renders a select → the choice posts back (similar plumbing to the
  existing permission round-trip: `POST /conversations/:id/permission/:toolCallId`).
  Likely a new AG-UI custom event type + a UI widget + a bridge tool handler.

- [ ] **Broker permissions / approval system.** Today the broker is
  passthrough (any holder of a conversation's SA token can use any enabled
  provider route). Add a permissions model where an agent can *request expanded
  permissions* (e.g. a new provider, a write scope, a specific repo) and the
  user *approves them in the UI*. Needs: a request representation, an approval
  UI surface (likely reusing the permission/approval round-trip), and broker
  enforcement keyed on what's been granted per conversation. Bigger design —
  spec it out (research → design → tests → impl) before building.

- [ ] **Show linked resources in the chat UI.** We already track conversation ↔
  external-resource links (`ConversationMap` / `ResourceLink`: github PR/issue,
  gitlab MR, slack thread, jira ticket). Surface them in the left chat panel
  under a collapsing tab: provider icon + link, e.g. GitHub icon + PR link,
  GitLab icon + MR link, Slack icon + thread + a brief header/summary of the
  conversation. Needs: an agent-host endpoint to expose a conversation's links
  (sourced from the webhooks store, or have the webhook push the link to the
  agent-host on create — there's already a `/conversations/link` route), and a
  collapsible UI component.

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
