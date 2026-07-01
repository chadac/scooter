# Design: Live conversation monitoring in the web UI

## Goal

When a Slack message (or GitHub, or another tab) drives a conversation, see it
**live in the web UI** — without switching away and back. Two parts, per the
scoping decision:

1. **Open conversation, live** — the conversation you have open streams messages
   as they happen, regardless of who drove the run (Slack webhook, another tab).
2. **Push new conversations** — a Slack thread pops into the sidebar instantly,
   not up to 10s later.

## Key finding: most of part 1 already exists (dormant)

The agent-host already serves **`GET /conversations/:id/events.integrity`**
(`management.ts:199-249`): a single ordered SSE stream that replays the full
event log (each event checksummed) then stays open for live appends, **fed off
the persist path** — so it sees *every* run including Slack-driven ones. A
matching client, **`subscribeIntegrity()`** (`ui/src/integrityStream.ts`), folds
those frames into a message list with self-healing checksum resync.

**Nothing wires the client into a React component.** The open conversation
(`RuntimeProvider.tsx`) hydrates history once via `loadHistory` then relies on
assistant-ui's `HttpAgent`/`/agui` stream — which only streams *runs this tab
initiated*. So a live Slack-driven run on an open conversation is invisible until
you switch away and back.

Part 1 is therefore mostly *wiring*, not new infra. Part 2 needs a new
server stream (no seam exists for conversation-list push today).

---

## Part 1 — open conversation live (small)

### Approach

In `ConversationRuntime` (`RuntimeProvider.tsx`), in addition to the one-shot
`loadHistory`, open `subscribeIntegrity(config, conversationId, onUpdate)` and
merge its folded messages into the assistant-ui thread.

### The two-writers problem — and why the final design has NONE

The naive wiring (integrity stream + assistant-ui's `HttpAgent` both writing the
thread) races: both want to own the message state. Early drafts guarded this with
an `isLocallyRunning` flag. **The final design (see Q6 below) removes the problem
instead of guarding it:** render the open conversation from a SINGLE source — the
integrity stream — and make sends fire-and-forget `POST /agui` whose reply comes
BACK through that same stream. One writer, no reconciliation, and a Slack-driven
run and a local run render through the identical path.

### Full fidelity (DECIDED): tool calls + reasoning, not just text

`subscribeIntegrity` today folds only `TEXT_MESSAGE_*` (`integrityStream.ts:41-56`).
The monitored view must match the full assistant-ui rendering — tool-call cards,
reasoning, plans — so the integrity path has to reproduce the SAME message model
the `HttpAgent`/`/agui` path produces from the identical AG-UI events
(`bridge.ts:42-76`: `TOOL_CALL_START/ARGS/END/RESULT`, `REASONING_*`,
`PERMISSION_RESOLVED`).

**Approach — reuse assistant-ui's own event applier, do NOT hand-roll a second
folder.** The bug risk in maintaining two independent event→message reducers (the
HttpAgent's internal one and a hand-written full-fidelity fold) is high and
exactly the kind of drift that produces "looks different when it's a Slack run."
So:

- The integrity stream carries the SAME AG-UI events the `/agui` SSE does (they're
  both the bridge's `AguiEvent`s; integrity just wraps each in a checksum envelope
  — `management.ts:213` vs the encoder path). Strip the envelope and feed the raw
  events through assistant-ui's AG-UI decoder so BOTH paths converge on one
  renderer.
- **Q5 — RESOLVED.** `@ag-ui/client`'s `AbstractAgent` has
  `abstract run(input: RunAgentInput): Observable<BaseEvent>`
  (`node_modules/@ag-ui/client/dist/index.d.ts:391`); `HttpAgent extends
  AbstractAgent` implements it by POSTing `/agui` and decoding the SSE into that
  Observable (`:379`). The base class owns the event→messages applier (it
  maintains `messages`/`state` via the `AgentSubscriber` pipeline, `:227-311`) —
  the SAME applier assistant-ui's `useAgUiRuntime` renders from.

  **The seam:** a small `IntegrityAgent extends AbstractAgent` whose `run()`
  returns an Observable sourced from `/conversations/:id/events.integrity` —
  strip the checksum envelope, map each integrity frame's inner event to the
  corresponding `@ag-ui/core` `BaseEvent`, and (on `synced`) emit the caught-up
  stream. Feed that agent to a second `useAgUiRuntime` (or reconcile into the
  same one). Because it goes through the identical base-class applier, the
  monitored view is byte-for-byte the SAME full-fidelity rendering (tool cards,
  reasoning, plans) as a locally-driven run — with ZERO second reducer to drift.

  This is option 1/2 from the earlier draft, confirmed feasible. Part 1 is now
  "a custom AbstractAgent + reconciler," not pure wiring, but keeps ONE renderer
  for both live paths — the correct trade.

### Revised two-writers reconciliation (given the IntegrityAgent)

**Q6 — RESOLVED, and it's the chosen shape.** The `/agui` POST handler
(`agui/server.ts:203`) calls `await promptHandler(...)`, which drives the run
SERVER-SIDE; the run proceeds and every event persists → flows to the integrity
stream — whether or not the caller consumes the POST's SSE body.

**Latency of the single-source model — MEASURED (negligible).** The only cost of
routing your own send's reply back through the persist→integrity path (instead of
the direct `/agui` SSE) is how much later each event lands on the integrity stream.
Measured locally (fake agent, file store), per-event delta (integrity − direct)
over a full run: **p50 0.7 ms, p90 7 ms, max 44 ms, mean 3.5 ms** — all well below
perception. `onAppend` fires right after the durable write, so it stays low-ms. No
fallback needed; single-source stands.

**Part-1 architecture (final): ONE runtime, fed solely by the `IntegrityAgent`;
sends are fire-and-forget `POST /agui`.** The open conversation always renders
from `/conversations/:id/events.integrity`. When the user sends, we POST to
`/agui` and DON'T read its SSE — the reply comes back through the integrity
stream like any other run. This ELIMINATES the two-writers problem: there is
exactly one writer (the integrity stream), so a Slack run and a local-tab run
render through the identical path with no reconciliation guard.

Trade-off for Design: assistant-ui's composer normally sends via the runtime's
own agent (consuming its SSE). Options: (a) give the runtime the IntegrityAgent
and override the composer send to a fire-and-forget `/agui` POST; or (b) keep the
send on a throwaway HttpAgent whose SSE we ignore. Either keeps rendering
single-sourced. Confirm the assistant-ui send-override API in Design (Q7).

(The earlier two-runtime "isLocallyRunning" reconciler is now MOOT — the
single-integrity-source model replaces it. Kept in git history, removed here.)

### Files touched (part 1)

- `ui/src/integrityAgent.ts` (new) — `IntegrityAgent extends AbstractAgent`;
  `run()` returns an `Observable<BaseEvent>` sourced from
  `/conversations/:id/events.integrity` (strip envelope → map inner event to the
  `@ag-ui/core` event). Reuses the existing SSE parser in `integrityStream.ts`.
- `ui/src/RuntimeProvider.tsx` — feed `useAgUiRuntime` the `IntegrityAgent` for
  the open conversation; route composer sends to a fire-and-forget `POST /agui`
  (Q7). The one-shot `loadHistory` reset is removed — the integrity stream's
  replay is the history.
- (No server change for part 1 — `/events.integrity` already does the job.)

### Tests (part 1)

- **Tier 1 (unit, `ui` vitest project):** `IntegrityAgent.run()` maps a scripted
  integrity frame sequence (text + a TOOL_CALL_START/ARGS/END/RESULT + a
  REASONING_* block, each checksum-wrapped) into the correct `BaseEvent`
  Observable, and the base-class applier yields the expected full-fidelity
  `messages` (tool call present, reasoning present). Reuse `integrityStream.ts`'s
  fake SSE harness.
- **Tier 1:** a send routes to `POST /agui` fire-and-forget (doesn't block on / read
  the SSE) and does NOT write the thread directly (render stays single-sourced).

---

## Part 2 — push new conversations into the sidebar (new server stream)

### Approach

Add a **global conversation-list SSE stream** the sidebar subscribes to, so a
newly-created (e.g. Slack) conversation appears instantly instead of on the next
10s poll. Keep the 10s poll as a reconcile/backstop (belt-and-suspenders, like
the integrity stream's history refetch).

### Server

1. **SessionManager lifecycle events** — `manager.ts` has no emitter today
   (only `saveMeta`). Add an `onConversationChange(cb)` emitter that fires on
   `start` (new conversation) and `setTitle` (agent-assigned title), passing the
   `ConversationView` (+ its `sources`). Fire it from the same points that call
   `saveMeta` (`manager.ts:272, 292, 389`).
   - Cost: the `sources` enrichment needs a `listLinks` call; do it lazily in the
     stream handler, not in the hot path.

2. **New route `GET /conversations/events`** (management.ts) — an SSE stream that:
   - emits an initial `{ kind: "snapshot", conversations: [...] }` (the current
     visible list, same shape/scope logic as `GET /conversations`);
   - then forwards `{ kind: "upsert", conversation }` on each
     `onConversationChange`, filtered by the caller's `scope`/identity (reuse the
     `visible()` predicate at `management.ts:106-107`).
   - Mirror the integrity stream's connection bookkeeping (`Map<..., Set<res>>`,
     cleanup on close) from `agui/server.ts`.

   NOTE the security model: identity is a *view filter*, not access control
   (`identity.ts:12-14`) — an anonymous caller sees everything. The stream must
   honor the SAME filter as the REST list so it doesn't leak more than the poll
   already does (it doesn't — public conversations are already all-visible).

### UI

3. **`ui/src/conversationStream.ts`** (new) — `subscribeConversations(config, scope,
   onSnapshot, onUpsert)`, modeled on `integrityStream.ts`'s fetch+ReadableStream
   SSE parser (reuse the parser). Resilient: reconnect on drop; the existing 10s
   poll stays as reconcile.

4. **`ui/src/main.tsx` / `sessions.ts`** — on `upsert`, call
   `sessionStore.mergeFromServer([conversation])` (the same merge the poll uses,
   `sessions.ts:134-194`), so a Slack conversation's row appears immediately with
   its Slack source badge. Keep `setInterval(refreshConversations, 10000)` as the
   backstop; the stream just makes it feel instant.

### Files touched (part 2)

- `services/agent-host/src/session/manager.ts` — `onConversationChange` emitter.
- `services/agent-host/src/api/management.ts` — `GET /conversations/events` SSE.
- `services/agent-host/src/index.ts` — wire the emitter to the route.
- `ui/src/conversationStream.ts` (new) + `main.tsx`/`sessions.ts` wiring.

### Tests (part 2)

- **Tier 1 (agent-host contract):** `GET /conversations/events` emits an initial
  snapshot, then an `upsert` when a new conversation starts and when a title is
  set; respects `scope=mine` vs `all` (a fake identity). Model on the existing
  management/integrity contract tests.
- **Tier 1 (ui):** `subscribeConversations` parses snapshot + upsert frames and
  invokes callbacks; reconnects on a simulated drop.
- **Tier 3 (e2e, Playwright, fake agent):** drive a "Slack-like" conversation
  creation via the webhooks→agent-host path (or a direct `/agui` POST with a new
  threadId), assert the sidebar row appears WITHOUT a manual refresh, and — with
  that conversation open — assert the assistant's reply text streams into the
  open thread live. This is the acceptance test for the whole feature.

---

## Staging (per the PoC process)

DECIDED: full fidelity (tool calls + reasoning) + parts 1 and 2 land in ONE PR
(with the e2e acceptance test).

1. **Research** — this doc. Q5 (the event-applier reuse primitive) must be
   answered by reading the real `@ag-ui/client` API before Design.
2. **Design (boilerplate)** — signatures only, no bodies:
   - the integrity→assistant-ui applier wiring (per Q5's answer);
   - the `RuntimeProvider` reconciler (`isLocallyRunning` guard);
   - `SessionManager.onConversationChange` emitter type;
   - `GET /conversations/events` frame union + route signature;
   - `subscribeConversations` signature.
3. **Tests (red-first)** — Tier-1 `IntegrityAgent` full-fidelity test, Tier-1
   conversation-stream contract test, and the Tier-3 e2e acceptance spec.
4. **Review** — confirm the single-integrity-source model (one runtime, sends via
   fire-and-forget `/agui`), the frame shapes, and Q7 before implementing.
5. **Implementation** — one PR: part 1 (open-conversation full-fidelity live) +
   part 2 (conversation-list push), turning the tests green.

## Open questions

RESOLVED during research:
- **Q5 (full-fidelity applier) — RESOLVED:** subclass `AbstractAgent`
  (`IntegrityAgent`) whose `run()` sources events from the integrity stream; the
  base-class applier gives identical full-fidelity rendering. One renderer.
- **Q6 (single source, no two-writers) — RESOLVED:** `/agui` drives runs
  server-side regardless of SSE consumption, so render solely from integrity and
  send fire-and-forget. No reconciliation needed.

REMAINING for the Design gate:
- **Q7 (send override) — RESOLVED.** `useAgUiRuntime({ agent })` calls
  `agent.runAgent()` on send, which internally drives `agent.run(input)` and folds
  its events into `messages` (base class, `AbstractAgent` @
  `@ag-ui/client/dist/index.d.ts:483-516`). `runAgent` is ONE-SHOT (resolves when
  the run's Observable completes); the integrity stream is CONTINUOUS. So we do
  NOT source `runAgent`'s run from integrity. Design:
  - `IntegrityAgent.run(input)` returns a **continuous** `Observable<BaseEvent>`
    from `/conversations/:id/events.integrity` (maps envelope→event; never
    completes while open) — this is the RENDER source. Subscribe it once on mount
    (via a bare `run().subscribe(...)` feeding the agent's `messages`, OR by a
    long-lived `runAgent` if the runtime tolerates a non-completing run —
    determine which the runtime expects; prefer the explicit subscribe).
  - **Sends** are a fire-and-forget `POST /agui` issued from the composer-send
    override (or a thin wrapper), NOT via `runAgent`. The reply re-enters through
    the same continuous integrity subscription. No SSE consumed on send.
  Net: one agent, `run()` = integrity (render), send = `/agui` POST. Confirm the
  precise assistant-ui hook to intercept composer send during Design boilerplate.
- **Q8 (interrupts) — RESOLVED.** `AbstractAgent.pendingInterrupts` is populated
  from `RUN_FINISHED outcome.type==="interrupt"` (index.d.ts:494-496), and
  `useAgUiRuntime` exposes `unstable_getPendingInterrupts` /
  `unstable_submitInterruptResponses` (useAgUiRuntime.d.ts). Since the integrity
  log CONTAINS the RUN_FINISHED-with-interrupt event, the IntegrityAgent's `run()`
  emits it → the interrupt surfaces in the UI. The user's answer submits via
  `unstable_submitInterruptResponses` → route it as a `POST /agui` with `resume[]`
  (the existing resume path, `agui/server.ts:191-193`). Verify the submit hook
  wiring in Design.
- **Q3 (part 2 stream shape):** one global `/conversations/events` stream (chosen)
  vs. N per-conversation integrity streams (rejected: heavy). Confirm the global
  stream honors the SAME view-filter as `GET /conversations` (no new leak).
- **Q4 (part 2 scale):** `/conversations` does not paginate/cap today; the stream
  snapshot inherits that. Fine unless the list is already large — add a cap to both
  poll and snapshot if so. Out of scope otherwise.
- **Q8 (interrupts over integrity):** a run can pause on a permission/option
  interrupt (RUN_FINISHED outcome=interrupt). Rendering from integrity must still
  surface the interrupt AND let the user answer (resume via `/agui` resume[]).
  Confirm the IntegrityAgent forwards the interrupt outcome and the send-path
  carries resumes. (Likely fine — the events are in the log — but verify in Design.)
