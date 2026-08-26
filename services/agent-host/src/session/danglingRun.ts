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
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") return false; // last run completed
    if (e.type === "RUN_STARTED") return !isOwnRun(e, self);
  }
  return false; // no run markers at all
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
