# Conversation state: stores, invariants, and the authority inversion

**Status:** analysis + proposal. The rename in "The naming inversion" is implemented; everything
under "The single source of truth" is proposed, not built.
**Written:** 2026-08-21, after a production leak on `scooter.odin.lan` where 21 conversation
sandboxes (42 requested cores on a 24-core node) were never reclaimed, deadlocking every
agent-host rollout.

## Why this document exists

**The `Conversation` CR is the single source of truth.** It is durable, controller-reconciled, and
already carries everything needed to reconstruct a conversation. Every other store is a cache of it,
history hanging off it, or its body.

That is the intended design. The implementation does not follow it: a conversation's liveness is
represented in **five** places, two of which die with the pod, and the code treats one of the
*ephemeral* ones as authoritative while **never reading the CR back at all**. That inversion is not
a bug in one function — it is a property of the design as built, and it has now produced at least
four separately-diagnosed incidents that were all the same root cause.

The immediate trigger: sandboxes never auto-suspend in multi-replica. The sweep runs, is correctly
configured, and reclaims nothing, silently, forever.

## The five stores

| # | Store | Durability | Written by | Read by |
|---|-------|-----------|-----------|---------|
| 1 | `entries` (in-memory `Map`) | dies with the pod | every manager mutation | `sweepIdle`, `list`, `get`, nearly all of manager |
| 2 | `LOCAL_STATE_PATH` file store (was `STATE_PATH`) | **dies with the pod** (`emptyDir`) | every manager mutation (`saveMeta`) | `hydrate()` |
| 3 | `MIRROR_STATE_PATH` file store | durable (RWX PVC) | mirrored async from #2 | `hydrateFromMirror(id)` — **per-conversation only** |
| 4 | `Conversation` CR | durable (etcd) | `register()` / `setPhase()`, fire-and-forget | the controller and router — **never read back by the host** ← *should be the source of truth* |
| 5 | `Sandbox` CR + its pod | durable (etcd) | the provisioner | `provisioner.reconcile()` |

Deployed values (`modules/platform.nix` → the agent-host Deployment):

```
LOCAL_STATE_PATH  = /var/lib/agent-host/conversations     volume "state"          -> emptyDir
MIRROR_STATE_PATH = /var/lib/agent-history/conversations  volume "history-mirror" -> PVC
```

### The naming inversion

`STATE_PATH` reads as *the* state, and the code follows the name: it is commented "hot-path
**authority**" (`index.ts`), and `hydrate()` reads it to answer *"which conversations exist?"*.
It is an `emptyDir`. It cannot answer that question after a restart.

`MIRROR_STATE_PATH` is the one that survives, and it is named *mirror* — a backup — so no boot path
consults it for existence.

**The names invert which store is authoritative, and the code inherited the inversion.** Renaming
is not cosmetic here: with `STATE_PATH`, `hydrate()` reading local state looks correct; as
`LOCAL_STATE_PATH`, the same line reads as obviously wrong.

**DONE** (this branch): `STATE_PATH` → `LOCAL_STATE_PATH`, the ephemeral working set of
conversations this pod is actively serving. The old name is still read as a fallback so a pod whose
manifest predates the rollout keeps working; drop it once no deployed manifest sets it.
`MIRROR_STATE_PATH` keeps its name for now but is documented as what it is — the persistent
conversation record, not a backup. `entries` is fine as an in-memory index of what this pod serves:
the defect is not that the cache exists, it is that a cache is the reclaim path's only input.

## Invariants

Stated as properties the system should satisfy. Each is followed by whether it currently holds and
what enforces it. "Nothing" appears more often than it should.

### I1 — Every running Sandbox is known to some agent-host
> For every `Sandbox` with `operatingMode=Running`, some agent-host holds a corresponding entry.

**VIOLATED in production.** Measured on odin: 21 running Sandboxes, 48 `Conversation` CRs, 59
conversation dirs in the mirror — and `GET /conversations` returned **0**. Enforced by: nothing.
Nothing ever compares the durable objects against the hosts' beliefs.

### I2 — Every running Sandbox is eventually suspended or reaped
> A Sandbox left idle beyond `IDLE_SUSPEND_MS` is suspended.

**VIOLATED.** `sweepIdle` iterates `entries.values()` (store #1). With I1 broken the map is empty,
so the sweep is a no-op. It logs *only when it suspends something*, so a total failure is
indistinguishable from a quiet, healthy system. Enforced by: the sweep, which cannot see the leak.

### I3 — Local state is a cache, never the source of existence
> Answering "which conversations exist?" must be answered by the `Conversation` CR, never by an
> ephemeral store.

**VIOLATED by construction.** `hydrate()`'s loop is `for (const m of metas)` over the local store.
The cluster's answer (`live`, from `reconcile()`) is consulted only as `live.get(name)` — a lookup
*keyed by a local record*. A running Sandbox with no local meta is unreachable by that loop; when
`metas` is empty the body never executes at all. `reconcile()` correctly reports the running
sandbox and hydrate discards it.

### I4 — The durable record is readable, not just writable
> Anything the host relies on must be readable back.

**VIOLATED for store #4.** The host writes `Conversation` CRs via `register()`/`setPhase()`, both
documented "never throws — a k8s failure is logged, not propagated," and **never reads them back**.
A failed write silently diverges the durable record from the host's belief with no reconciliation
path. Store #3 is readable but only per-conversation (`hydrateFromMirror(id)`) — you must already
know the id, so it cannot answer an existence question either.

### I5 — A leaked sandbox is recoverable through the normal API
> An operator or sweep can reclaim any running sandbox.

**VIOLATED.** `suspend(id)` opens with `if (!entry) throw new Error(...)`. A sandbox not in
`entries` cannot be suspended through the manager at all. The leak is not merely unswept — it is
unreachable by design, which is why reclaiming it today means `kubectl` surgery.

### I5b — Interrupted runs are recovered after a restart
> A run that was in flight when its host died is resumed or failed, not left dangling.

**VIOLATED by the same blindness.** `resumeInterrupted()` also iterates `entries.values()`
(`manager.ts:1201`). An empty map means no candidates, so a dangling run on a conversation this pod
never hydrated is never recovered. Listed separately because it is a *second* consumer of the same
broken input — evidence that the defect is the input, not the sweep.

### I6 — Exactly one host owns a conversation at a time
Holds, and is genuinely enforced — `ownershipGuard` + CR `hostPod`/generation fencing. Noted to
show the contrast: this invariant has a real mechanism because it was designed as one.

### I7 — Suspend preserves queued work
Holds. `suspend()` drains the bridge queue to `pendingQueue` and persists **before** teardown;
`revive()` re-enqueues. (Regression-tested; see the vanishing-message work.)

## The pattern

I1–I5b fail the same way: **the source of truth is never consulted.** The `Conversation` CR can
answer every one of these questions and is asked none of them; the ephemeral store is asked instead. Every incident below was diagnosed separately, and each was
this:

- conversations vanish from the sidebar after redeploy → hydrate reads local, not the mirror
- sandboxes never auto-suspend → same, plus the sweep can only see `entries`
- orphaned sandboxes accumulate (92/99 at one point) → nothing reconciles cluster → host
- phase drift (`Assigned` forever on a suspended conversation) → CR written fire-and-forget, never read back

Note the failure mode is uniformly **silent**. None of these throw. The sweep logs on success only;
CR writes swallow errors by contract; hydrate falls back to "assume all suspended." A system whose
reclaim path can fail completely without emitting a single line is one where the next occurrence is
also found by hand.

## The single source of truth: the `Conversation` CR

**The `Conversation` CR is the source of truth for a conversation's existence, ownership, and
liveness. Every other store is derived from it, caches it, or is history hanging off it.** Where any
store disagrees with the CR, the CR is right and the other store is stale.

This is not a new component to build. It already exists, it is already durable in etcd, it is
already reconciled by a controller, it already survives every pod, and — as shown below — it already
carries everything needed to reconstruct a conversation. The defect is that **nothing reads it
back**.

A live CR today:

```yaml
spec:
  owner: chadac
  sandboxRef: conv-lkp9m
status:
  phase: Suspended
  generation: 2
```

Plus `model` / `parentId` in spec and `hostPod` / `hostIP` in status when assigned. That is
identity, backing sandbox, liveness, and assignment — sufficient to rebuild an `Entry` without
consulting any ephemeral store.

### What each store becomes, once the CR is authoritative

| Store | Role under the target model |
|-------|------------------------------|
| `Conversation` CR | **SOURCE OF TRUTH.** Existence, owner, model, parentId, sandboxRef, phase, assignment. Read on boot; read when reconciling; written on every lifecycle transition. |
| `Sandbox` CR + pod | The CR's *body*, referenced by `spec.sandboxRef`. Authoritative for whether the pod is currently running; never for whether the conversation exists. |
| `MIRROR_STATE_PATH` | The durable **history** (event log, transcript, queue) hanging off a CR. Rename to reflect that it is the persistent record, not a backup. |
| `LOCAL_STATE_PATH` (was `STATE_PATH`) | An explicit **cache** of the above for the conversations this pod serves. `emptyDir` is then correct rather than a trap: it is rebuildable by definition. |
| `entries` | An **in-memory index** of what this pod is actively serving. Fine as-is; it simply stops being the only input to reclaim paths. |

### The rule that follows

> **Any question of the form "does this conversation exist / who owns it / is it alive?" is answered
> by the CR — never by local state, and never by an in-memory map.**

Restating the current violations against that single rule makes them one bug, not five:

- **I1/I2/I3** — `hydrate()` loops over local metas and `sweepIdle`/`resumeInterrupted` loop over
  `entries`. All three should be driven by *listing CRs*. A CR whose `sandboxRef` names a running
  Sandbox with no local record is a conversation this pod must **adopt**, not ignore.
- **I4** — `register()`/`setPhase()` are fire-and-forget into the source of truth. A write to the
  authority that may silently fail, and is never read back, means the authority can drift with no
  detection. These must be reconciled: read the CR, compare, converge.
- **I5** — `suspend(id)` throws for anything not in `entries`. Under the target model a sandbox is
  suspendable because *its CR says so*, not because this pod happens to remember it.

### Direction of the fix (not a plan)

Boot becomes: **list `Conversation` CRs → reconcile against running Sandboxes → adopt what this pod
owns → hydrate history from the persistent store → serve.** Local state is populated *from* that,
never consulted to produce it. The reclaim paths iterate the reconciled set rather than whatever
happens to be in memory.

The test for any future change: *if every agent-host pod were deleted right now, what still knows
this conversation exists and is running?* The answer must be the CR, and the system must be able to
recover from exactly that.

### Why not formal verification (yet)

Considered and deliberately deferred for the storage questions. A TLA+ model of this system would
almost certainly declare `STATE_PATH` durable — because it is named `STATE_PATH` and commented
"authority" — and would then verify cleanly. The bug is that an `emptyDir` in a manifest makes that
premise false; model checking cannot catch a wrong premise about the deployment. It would have
proven the wrong thing with more confidence.

The cheaper instrument that *would* have caught this: **check the invariants against the live
cluster.** Query Sandboxes, `Conversation` CRs, and each pod's `/conversations`, then assert I1–I5.
Run it in CI against k3d and as a probe against a real cluster. "21 running Sandboxes, 0 known to
any host" is a one-line assertion that has been true and unnoticed for weeks.

Model checking remains a reasonable candidate for **multi-replica ownership handoff** specifically
(router + controller assignment + generation fencing + revive-on-assign racing over one
conversation) — real interleaving with real invariants, where I6's fencing is the kind of property
that is hard to test exhaustively. That is a separate decision from the storage model.

## Verification notes

Claims here were measured, not inferred:

- Mirror vs local, on a running pod: 59 conversation dirs under `MIRROR_STATE_PATH`, **0** under
  `STATE_PATH`.
- `GET /conversations` through the front door returned **0** while 48 CRs and 21 running sandboxes
  existed.
- The leak was reproduced in isolation by pointing a second `SessionManager` at a *different, empty*
  file-store root while `reconcile()` reported the sandbox still running: `entries after hydrate: 0`,
  `swept: 0`, `suspend calls: 0`.
- `session.spec.ts:480` ("hydrate reconciles a still-running Sandbox as running so the idle sweep
  reclaims it") already encodes I2 and passes — because it hands **the same** file-store root to
  both simulated processes. It models a restart with durable state; production restarts with wiped
  state. The property was right; the fixture was more durable than the deployment.

That last point generalizes: several of these invariants *are* tested, and pass, against fixtures
whose durability does not match production. Any invariant work should state the durability
assumption explicitly.
