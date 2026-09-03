/**
 * Detect an INTERRUPTED conversation from its event log tail.
 *
 * A run is a RUN_STARTED … (events) … RUN_FINISHED|RUN_ERROR unit. If the agent-
 * host process dies mid-run, the last RUN_STARTED never gets its RUN_FINISHED/
 * RUN_ERROR — a "dangling" run. On restart we resume such conversations (revive +
 * a nudge to continue) instead of leaving the work stuck and the caller seeing a
 * spurious failure.
 *
 * We look at the tail only (the LAST run is what matters): scanning from the end,
 * a RUN_FINISHED/RUN_ERROR seen before any RUN_STARTED means the last run
 * completed; a RUN_STARTED seen first means it's dangling.
 */

import type { AguiEvent } from "../bridge.js";

/**
 * True iff the conversation's last run started but never finished AND was not started
 * by `self` — i.e. it is genuinely stranded, not merely in flight here.
 *
 * `events` should be the recent tail (order-preserving); an empty/finished log is not
 * dangling. Pass `self` (this pod + the generation it owns the conversation at) so a
 * run THIS pod is still executing is not mistaken for one a dead pod left behind —
 * without it, revive-on-assign nudged a conversation's own live first run and the user
 * saw a spurious "interrupted by a restart" during their first message.
 */
export function hasDanglingRun(events: AguiEvent[], self?: RunOrigin): boolean {
  return danglingRunInfo(events, self) !== null;
}

/** The dangling run's identity + whether the user asked to STOP it before the old
 *  host died. `cancelRequested` distinguishes "resume the stranded work" from
 *  "the user stopped this; mark it terminal" — without it, a Stop that raced a
 *  scale-down was resurrected by the next owner's resume nudge. */
export interface DanglingRunInfo {
  runId: string;
  threadId: string;
  cancelRequested: boolean;
}

export function danglingRunInfo(events: AguiEvent[], self?: RunOrigin): DanglingRunInfo | null {
  let cancelled: string | undefined; // runId named by a CANCEL_REQUESTED seen in the tail
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") return null; // last run completed
    if (e.type === "CANCEL_REQUESTED") cancelled = e.runId;
    if (e.type === "RUN_STARTED") {
      if (isOwnRun(e, self)) return null;
      return { runId: e.runId, threadId: e.threadId, cancelRequested: cancelled === e.runId };
    }
  }
  return null; // no run markers at all
}

/** Who is asking: this pod, at the generation it owns the conversation at. */
export interface RunOrigin {
  host: string;
  gen?: number;
}

/**
 * True iff `started` was begun by the CALLER — i.e. the caller is still executing it,
 * so it is in flight rather than stranded.
 *
 * Conservative by design: with no caller identity (single-replica), or an event from
 * before RUN_STARTED carried an origin, this returns false and the run reads as
 * dangling — preserving the original behaviour rather than silently skipping a resume
 * a rollout depends on.
 */
function isOwnRun(started: { host?: string; gen?: number }, self?: RunOrigin): boolean {
  if (!self || started.host === undefined) return false; // unknown origin -> treat as foreign
  if (started.host !== self.host) return false; // a different pod started it
  // Same pod, EARLIER generation: the conversation was reassigned away and back, so
  // that run is genuinely stranded even though the host name matches.
  if (self.gen !== undefined && started.gen !== undefined && started.gen < self.gen) return false;
  return true;
}

/**
 * True iff the conversation has run at least once AND its last run COMPLETED
 * (RUN_FINISHED/RUN_ERROR seen before any RUN_STARTED, scanning from the end).
 * The completion signal for the subagent watcher — robust to a run that starts
 * and finishes BETWEEN watcher ticks (unlike edge-detecting the live bridge's
 * `running` flag, which misses a fast run entirely).
 */
export function lastRunCompleted(events: AguiEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === "RUN_FINISHED" || t === "RUN_ERROR") return true; // a completed run exists
    if (t === "RUN_STARTED") return false; // last run is still in flight (dangling)
  }
  return false; // no runs yet
}

/** A run that started and never reached a terminal, anywhere in the log. */
export interface OrphanRun {
  runId: string;
  threadId: string;
}

/**
 * Every run in `events` with a RUN_STARTED and no RUN_FINISHED/RUN_ERROR, oldest
 * first.
 *
 * `danglingRunInfo` deliberately looks only at the TAIL, so it answers "is the
 * conversation mid-run right now?" — it stops at the first terminal it meets
 * scanning backwards. That makes it blind to an orphan BURIED under a later
 * completed run, which is exactly what an ownership fence leaves behind: the
 * outgoing pod's remaining events (terminal included) are dropped, the next turn
 * completes normally on the new owner, and the orphan is now unreachable. The
 * conversation never self-heals, and the UI's `running` flag — a boolean, not a
 * counter — reads the stray RUN_STARTED as "still working" forever.
 *
 * Pairing by runId finds those. Used on adopt to close them: the adopting pod is
 * the sole writer (controller keeps one hostPod, the fence blocks the old one),
 * so writing a terminal here cannot race the run's real author.
 */
export function orphanRuns(events: AguiEvent[]): OrphanRun[] {
  const started = new Map<string, string>(); // runId -> threadId
  const ended = new Set<string>();
  for (const e of events) {
    const runId = (e as { runId?: string }).runId;
    if (!runId) continue;
    if (e.type === "RUN_STARTED") {
      started.set(runId, String((e as { threadId?: string }).threadId ?? ""));
    } else if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") {
      ended.add(runId);
    }
  }
  return [...started]
    .filter(([runId]) => !ended.has(runId))
    .map(([runId, threadId]) => ({ runId, threadId }));
}