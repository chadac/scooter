# Agent-host sharding — research + design spec

**Status:** Research (Stage 1 of the PoC process). Design/tests/impl follow.

## Problem

A single agent-host pod hosts **every** conversation's goose subprocess, ACP↔AG-UI
bridge, SSE fan-out, and exec WebSocket. Past some N conversations the one Node
event loop + memory can't keep up and **all** conversations degrade (the overload
behind the node-death incidents). We need to cap conversations-per-pod and scale
horizontally.

## Shape (decided in planning)

A **thin stateless router** in front of **N stateful agent-host shards**
(a StatefulSet). Each conversation is **pinned** to one shard; every request for
that conversation — HTTP, SSE, WebSocket — is routed to its shard. Shards have a
**capacity cap** and the set **autoscales**. Conversation state moves off the
single local PVC into **shared Postgres (hot) + a configurable cold store**, so any
shard can own any conversation and rebalancing/failover are clean.

| Decision | Choice |
|----------|--------|
| Topology | Thin stateless **router** → **N stateful shards** (StatefulSet, stable per-pod DNS `agent-host-<ord>`) |
| Assignment | **Router-owned table in shared Postgres** (`conversation_shard`): conversationId → shard, assigned at create to the least-loaded shard under its cap |
| Capacity | Per-shard **cap** on active conversations + **autoscale** (HPA on active-conversation count) |
| State | **Tiered**: Postgres = hot cache (metadata, links, assignment, last-N events + integrity head); **configurable cold store** (S3 / PVC) = full durable event log. `fileStore` becomes one cold backend behind a new `EventStore` seam |
| Failover | **Drain-before-move** for planned rebalances (reassign only when idle); **re-derive** (replay + existing `resumeInterrupted`/revive-with-history) when a shard dies unexpectedly |
| Scope | **Full feature in one PR**, built in **reviewable staged commits behind a flag** (each green; `replicas=1` behaves exactly like today until enabled) |
| Router form | **Separate tiny service** (`services/router/`) — not an agent-host "mode" |
| Event seq | **Shard-local seq**, correctness from an **ownership lease** (one shard owns a conversation at a time) — no per-event DB round-trip |

## Why a router, not round-robin

The agent-host is **stateful per conversation**: a goose child process, the ACP
session, the run queue, pending permission interrupts, and SSE subscriber sets all
live in **one shard's memory** (`bridge.ts`, `acp/client.ts`). Prompts, SSE
replays, interrupt answers, and the `/c/<id>/…` proxy for a conversation must all
land on the **same** shard that holds its live bridge. So this is sticky,
conversation-affinity routing — a sharded sessionful service — not a stateless LB.

---

## Component 1 — the router

A small service (its own Deployment; can be many stateless replicas behind a
Service) that owns the `agent-host` Service DNS name today's callers use
(UI via nginx, broker, webhooks all hit `agent-host.<ns>.svc:8080`). It:

1. **Extracts the conversation id** from the request. Three forms (all exist
   today — see `management.ts` `resolveConvId`):
   - path param `:id` (most routes),
   - `body.threadId` (POST `/agui` — must peek the JSON body without consuming the
     stream for the downstream forward),
   - the **short hash** (`sandbox-<shortId>`) the broker sends to `/aws-request`.
2. **Resolves the owning shard** from the assignment table (Postgres, cached with
   a short TTL + invalidation on reassignment). On a **create** (`POST
   /conversations`, or first `/agui` for an unknown thread) it **assigns** a shard
   (least-loaded under cap) and writes the row.
3. **Forwards** to `agent-host-<ord>.agent-host-headless.<ns>.svc:8080`,
   transparently proxying **HTTP, SSE (no buffering, long timeout), and WebSocket
   upgrade** (the `/c/…` proxy + exec streams ride WS). This is the same
   HTTP+upgrade proxy shape the web-service proxy already implements
   (`proxy/webServiceProxy.ts`) — reuse the pattern.
4. **No conversation state** of its own beyond the cache — the table is the source
   of truth, so the router scales/restarts freely.

Router interface seam (new, `services/router/` or `agent-host/src/router/`):

```
resolveShard(convId) -> { ord, host } | assign(convId) -> …   // table-backed
forward(req, res, shardHost)                                   // HTTP+SSE+WS proxy
peekThreadId(req) -> convId                                    // body/path/short-hash
```

**Open items:** router as a new service vs. an "agent-host in router mode"
(same image, a flag); how the router discovers live shards + their load (watch the
StatefulSet pods + a shard `/shard/stats` endpoint, or read a heartbeat row each
shard writes). Leaning: separate tiny service, shard-load via a `shard_heartbeat`
table each shard updates (active count, ready) — no k8s watch needed, survives in
the same DB as assignments.

## Component 2 — shard-scoped ownership

Today `hydrate()`/`reconcile()` list **all** `conv-*` Sandboxes namespace-wide, so
N shards would each try to adopt **every** conversation. This MUST become
**shard-scoped**:

- `hydrate()` loads only conversations whose `conversation_shard.ord == MY_ORD`.
- `sweepIdle()` / `resumeInterrupted()` iterate only owned conversations.
- A shard learns its ordinal from the StatefulSet pod name (`$HOSTNAME` →
  `agent-host-<ord>`) or `POD_ORDINAL` env (downward API).
- The provisioner still creates the Sandbox/SA/PVC/ConfigMap as today; ownership is
  about which shard runs the bridge, not who can touch the Sandbox (any shard can
  revive any Sandbox — verified safe).

Each shard exposes `/shard/stats` (active count, cap, ready) and writes a
`shard_heartbeat` row for the router's placement decisions.

## Component 3 — the state refactor (the big lift)

Move conversation state off the single RWO PVC + local files so any shard can own
any conversation. Introduce a store seam and a tiered implementation.

Today (`fileStore.ts`, one PVC): per-conversation `events.jsonl`, `meta.json`,
`links.json`, `module.nix`, `jobs.json`.

New shape:
- **Metadata / links / module / jobs / assignment / heartbeat → Postgres.**
  (`conversation`, `conversation_link`, `conversation_module`, `conversation_job`,
  `conversation_shard`, `shard_heartbeat` tables.) These are small and benefit from
  transactional, any-shard access. The broker already shares a Postgres instance
  (`modules/broker.nix`), so the infra exists.
- **Event log → a tiered `EventStore` seam:**
  - **Hot cache in Postgres**: the last N events per conversation + the rolling
    integrity checksum head, for fast first-paint (`/tail`) and the integrity
    stream. Bounded rows (trim past N).
  - **Cold durable log in a CONFIGURABLE backend** (S3 or a PVC dir), the full
    append-only event history for full replay (`/history`) and re-derive. `fileStore`
    becomes the PVC cold backend; an S3 backend is the cloud option.
  - Replay reads hot-cache first, falls back to the cold log for older events.

```
interface EventStore {
  append(convId, event): Promise<{ seq, checksum }>   // hot + cold
  readAll(convId): AsyncIterable<Event>                // cold (full replay)
  readTail(convId, n): Promise<Event[]>                // hot cache
  integrityHead(convId): Promise<{ seq, checksum }>    // hot cache
}
```

The existing `ConversationStore` interface (`manager.ts`) is the natural seam to
split: metadata/links/module/jobs → a `PgConversationStore`; events → the tiered
`EventStore`. Keep the current `fileStore` working (local/dev + the PVC cold
backend) so Tier-1 tests stay hermetic.

**Open items:** exact hot-cache N; event id/seq scheme (must be monotonic per
conversation across shards — see the event-id-collision history; a Postgres
sequence or per-conversation seq column settles it); S3 layout (per-run objects vs
one append blob); migration of existing on-PVC conversations.

## Component 4 — capacity + autoscale

- Each shard advertises `activeConversations` and a `maxConversations` cap (config).
- **Placement:** the router assigns a new conversation to the least-loaded shard
  with `active < cap`. If none, it triggers scale-up (see below) and places on the
  new shard once Ready.
- **Autoscale:** HPA (or KEDA) on a custom metric = cluster-wide active
  conversations / cap, so the StatefulSet grows when shards fill. Scale-DOWN is
  gated by drain (below) — never cut a shard with live conversations.

**Open items:** custom-metric plumbing (Prometheus adapter on the `shard_heartbeat`
counts, or KEDA on a Postgres query); StatefulSet scale-down ordering (highest
ordinal first — must be drained first).

## Component 5 — failover / rebalance

- **Drain-before-move (planned):** to rebalance or scale down, the router marks a
  conversation for move, waits until it's **idle** (no active run — the bridge
  exposes this), then reassigns the row and lets the new shard cold-start it from
  the store on the next request. No interrupted turns.
- **Re-derive (unplanned):** if a shard dies, its conversations' rows are
  reassigned; the new shard rebuilds each from the store on next access — replay
  events + the existing revive-with-history + `resumeInterrupted` nudge for a
  dangling run. This path already exists for restart recovery; sharding reuses it.

**Open items:** how the router detects a dead shard (heartbeat staleness) and
reassigns in bulk; preventing two shards briefly both owning a conversation during
a move (a `generation`/lease column on the assignment row — a shard checks it owns
the current generation before spawning goose).

---

## Deployment changes (`modules/platform.nix`)

- agent-host **Deployment → StatefulSet** (`agent-host-<ord>`, headless Service
  `agent-host-headless` for stable per-pod DNS). Per-pod PVC only if a PVC cold
  backend is used; with S3 cold + Postgres hot, the per-pod PVC can be small/absent.
- New **router Deployment + Service** taking over the `agent-host` Service name (so
  UI/broker/webhooks are unchanged — they keep hitting `agent-host.<ns>.svc:8080`,
  now the router).
- Postgres: reuse the shared instance; add the agent-host schema/tables.
- HPA/KEDA + the custom metric source.
- Config: `SHARD_ORDINAL`, `MAX_CONVERSATIONS`, `EVENT_COLD_STORE=s3|pvc`,
  `DATABASE_URL`, `ROUTER_MODE`.

## Backwards-compat / migration

- `replicas=1` + router pass-through must behave exactly like today (a single
  shard, the router a no-op forwarder) so small deployments are unaffected.
- Existing on-PVC conversations: a one-time import into Postgres + cold store, or a
  fileStore cold backend that reads the legacy layout. Keep local/dev on fileStore.

---

## Build order (staged commits, one PR — each green behind a flag)

`replicas=1` + router pass-through must behave **exactly like today** until
sharding is enabled, so every stage is safe to merge.

0. **Ownership lease** (PROVE FIRST — the load-bearing correctness primitive).
   `conversation_shard` row carries `owner_ord` + a `lease` (generation/expiry).
   A shard acquires/renews the lease before spawning goose and checks it still
   holds it; a move bumps the generation so the old owner's stale writes are
   rejected. With shard-local seq, this lease is what prevents two shards double-
   owning a conversation (double goose / colliding seqs). Red-first contract test:
   only the current lease-holder may append/spawn; a superseded holder is fenced.
1. **EventStore seam + PgConversationStore** (no behavior change): split the store,
   tiered events (hot Pg cache + configurable cold), metadata/links/module/jobs →
   Postgres. fileStore stays as the PVC cold backend + dev.
2. **Shard-scoped ownership**: hydrate/sweepIdle/resumeInterrupted touch only owned
   conversations (by lease/`owner_ord`).
3. **Router** (`services/router/`): peek id (3 forms) → resolve/assign shard →
   proxy HTTP/SSE/WS. Atomic assign (INSERT … ON CONFLICT).
4. **Capacity + placement + HPA**: per-shard cap, least-loaded placement, custom
   metric.
5. **Rebalance / failover**: drain-before-move; dead-shard re-derive.

## Areas of uncertainty (resolve before/into Design)

1. **The ownership lease is the highest-risk correctness piece** (we chose
   shard-local seq, so the lease — not a DB sequence — is what guarantees a single
   owner). Must be airtight: acquire/renew/fence, and a shard checks it holds the
   current generation before every goose spawn + event append. A bad lease =
   double goose or colliding per-conversation seqs. **Prove in stage 0 before
   anything else.**
2. **Body-peeking for `/agui`** without breaking the forwarded stream (buffer the
   JSON, re-emit to the shard). SSE + WS must NOT be buffered.
3. **Move races** — two shards owning one conversation for a moment (double goose).
   A lease/generation on the assignment row + a shard-side ownership check.
4. **Custom-metric autoscale plumbing** (Prometheus adapter vs KEDA-on-Postgres).
5. **S3 cold event store** append/replay ergonomics + integrity.
6. **The single RWO PVC assumption** (`Recreate` strategy) is gone — validate the
   StatefulSet + shared-DB path end-to-end, incl. a shard restart.
7. **Router HA** — multiple router replicas assigning concurrently need the
   assignment insert to be atomic (unique conversationId, `INSERT … ON CONFLICT`).

## Explicitly out of scope (even in this "full" PR, unless small)

- Cross-region / multi-cluster sharding.
- Live process migration (we re-derive/drain, never migrate a goose PID).
- Per-user or per-org shard affinity (placement is load-based only).

---

## Test seams (previewing Stage 3)

- **Tier 1 (contract):**
  - Router: id extraction for all three forms; assign-on-create writes the row;
    resolve returns the pinned shard; forward proxies HTTP/SSE/WS (reuse the
    web-service proxy's fake-upstream pattern). Atomic assign under concurrent
    routers.
  - Shard-scoped ownership: `hydrate`/`sweepIdle`/`resumeInterrupted` touch ONLY
    owned conversations (fake store returning mixed ordinals).
  - `EventStore`: append→readTail (hot) + readAll (cold) ordering + integrity head;
    the tiered impl over a fake cold backend + an in-mem "pg".
  - `PgConversationStore`: metadata/links/module round-trip (against a test PG or a
    fake).
  - Lease/generation: a shard refuses to spawn goose for a conversation it doesn't
    own the current generation of.
- **Tier 2 (cluster):** a 2-shard StatefulSet + router; create conversations,
  assert they pin to distinct shards under load; kill a shard → its conversations
  re-derive on the survivor; drain-move an idle conversation; cap → new shard.
- **Tier 3 (e2e):** the UI unaffected — conversations work identically through the
  router; a burst spreads across shards.
