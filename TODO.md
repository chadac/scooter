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
