# Design: conversation interrupts (stop button, tool-call kill, priority queue)

Status: **DESIGN — for review before implementation.** Follows the staged PoC
process (Research → Design → Tests → Review → Implementation).

## Goal

1. A **Stop button + thinking indicator** in the chat UI while the agent works,
   so the user knows it's running and can interrupt.
2. A user interrupt that **cancels the in-flight run INCLUDING a running tool
   call** (e.g. a stuck shell command) — not just the text stream.
3. A **priority/timeout queue in the agent-host**: a queued message flagged
   priority (e.g. an `@scooter` mention) **force-interrupts** the running turn
   after a configurable timeout (default 5 min) and takes over. Webhooks only
   *tags* the forward as priority; the agent-host owns the timer.

## What exists today (from research)

- The composer **already has** a Stop button (`thread.tsx`), but it's dead:
  gated on `thread.isRunning`, which is ~always false because `runAgent` is
  shadowed fire-and-forget (`RuntimeProvider.tsx`). No client→server cancel.
- `bridge.cancel()` is a **stub** (ignores runId, only ACP `session/cancel`) and
  is **never called**.
- ACP `session/cancel` is real — tells goose to stop — but does **not** kill a
  running terminal.
- **Killing a running shell command is impossible today**: `TerminalHandle.kill()`
  is a no-op in every backend, and the k8s exec drops the WebSocket + ignores the
  AbortSignal.
- The run queue is an **opaque `runChain` promise** — no timestamps, depth, or
  priority.

## The four seams

### Seam 1 — Exec layer: make a terminal killable

**Split across two PRs** (the thorough pod reap needs image changes + a cluster
test we can't run locally):

- **PR 1 (this):** `k8sExec.ts` honors the `AbortSignal` and closes the pods/exec
  **WebSocket** on abort → SIGTERM to the command's shell (a foreground command
  dies with it). `sandboxExec.spawn().kill()` aborts the controller. Covers the
  common "stop a running command" case, fully unit-testable with the fake api.
- **PR 2 (follow-up):** the thorough **process-group reap** of orphaned background
  children — `setsid` + a targeted `pkill -f <marker>` (marker on the cmdline,
  process-group scope only). Requires adding **util-linux/procps** to the sandbox
  image (`modules/sandbox-os/default.nix` — currently only coreutils/findutils/
  grep/sed/gawk) and a Tier-2 cluster test to verify pod-kill behavior.
- `localExec.ts`: retain the child process; `kill()` sends SIGTERM (PR 1).

### Seam 2 — Bridge: a real, inspectable run queue + a real cancel
`services/agent-host/src/bridge.ts`.

- Replace the opaque `runChain` with an **inspectable queue**:
  `Array<{ input: PromptInput; priority: number; enqueuedAt: number; resolve; reject }>`
  plus `currentRun` and `currentRunStartedAt`. One run at a time still (the
  goose session is single-threaded), but now we can see depth, age, and priority.
- `prompt(input, opts?: { priority?: number })` enqueues; a pump drains FIFO
  within a priority tier. Preserves the "one run fully completes before the next
  RUN_STARTED" invariant (the corruption guard).
- `cancel(runId?)` — REAL now:
  1. Mark the current run cancelled (so its RUN_FINISHED/RUN_ERROR is emitted
     cleanly, messages closed).
  2. Kill the active tool call: call `killTerminal` on the run's in-flight
     terminal(s) via the ExecBackend (Seam 1). The bridge must know the active
     terminal id — thread it from `sandboxHandlers` (the createTerminal path) into
     the run state, or expose a `killActiveTerminals(sessionId)` on the exec seam.
  3. ACP `session/cancel` so goose stops requesting more.
  4. Emit a terminal event so the UI + log reflect the cancel (a RUN_FINISHED or a
     RUN_ERROR with a "cancelled" marker; persisted so a reload shows it ended).
- **Priority timeout:** a per-bridge timer (configurable, default 300s, 0 =
  disabled). When a queued item's `priority >= PRIORITY_INTERRUPT` has waited
  `> timeout` while a run is active, the pump calls `cancel(currentRunId)` to
  force the current turn to end, then the high-priority item runs next. Config via
  `deps.config` / an env-fed option.

### Seam 3 — Management API: a cancel endpoint
`services/agent-host/src/api/management.ts`.

- `POST /conversations/:id/cancel` → `sessions.get(id)?.bridge?.cancel()`.
  Threaded through `ManagementDeps` like `answerPermission`. 202/204 on success,
  404 if unknown, no-op-ok if nothing is running.
- `POST /agui` already carries prompts; the webhooks priority tag rides the
  RunAgentInput (a `priority`/`mention` flag) → `sessions.prompt(..., {priority})`.

### Seam 4 — UI: isRunning, the Stop button, the thinking indicator
`ui/src/integrityAgent.ts`, `RuntimeProvider.tsx`, `thread.tsx`.

- `IntegrityAgent`: add an `isRunning` getter derived from the log
  (`RUN_STARTED` → true; `RUN_FINISHED`/`RUN_ERROR` → false; ignore `ext-` runs).
  Mirror `trackInterrupt`. Surface it via context like interrupts.
- A conversation-level **thinking indicator** (pulsing "Scooter is working…")
  gated on `isRunning`.
- Wire the existing composer **Stop button** to a new `IntegrityAgent.cancel()`
  that POSTs `/conversations/:id/cancel`. Show the Stop button when `isRunning`.

## Webhooks (priority tag only)
`services/webhooks/`.

- When forwarding an `@scooter` **mention** to an ACTIVE conversation
  (`_contains_mention`), tag the `/agui` forward as **priority** (a field on the
  RunAgentInput or a query flag). No timer here — the agent-host owns it.

## Config
`modules/*.nix` + agent-host config: `interrupt.priorityTimeoutSeconds`
(default 300, 0 = never force-interrupt). Env `PRIORITY_INTERRUPT_TIMEOUT`.

## Tests (red-first)
- **Tier 1 (bridge):** queue orders by priority; a priority item waiting >
  timeout triggers cancel of the current run; cancel emits a clean terminal event
  + closes open messages; cancel calls killTerminal on the active tool call.
- **Tier 1 (exec):** `kill()` aborts the exec + issues the pkill (fake api asserts
  the kill/pkill calls).
- **Tier 1 (UI):** `isRunning` flips on RUN_STARTED/RUN_FINISHED, ignores `ext-`.
- **Tier 3 (e2e):** a long `!sleep 30` run shows the Stop button + thinking
  indicator; clicking Stop cancels it (the run ends, a new prompt works); a
  priority-tagged message force-interrupts after a (test-shortened) timeout.

## Decisions (confirmed)
1. **pkill scope:** kill the exec's **process group only** (the shell + its
   children — the aborted exec's PGID), NOT a name/pattern sweep. Won't touch
   unrelated processes in the shared pod.
2. **Cancel event:** emit **`RUN_FINISHED` with a `cancelled: true` marker** (not
   RUN_ERROR). The run ends cleanly; the UI shows "You stopped this turn," not a
   red error.
3. **Priority trigger:** force-interrupt **only for explicitly priority-flagged
   items** (e.g. an `@scooter` mention). Normal queued messages never
   force-interrupt — they wait. Timeout default **300s**, configurable, `0` = off.
