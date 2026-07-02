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
 * True iff the conversation's last run started but never finished (interrupted).
 * `events` should be the recent tail (order-preserving); an empty/finished log is
 * not dangling.
 */
export function hasDanglingRun(events: AguiEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === "RUN_FINISHED" || t === "RUN_ERROR") return false; // last run completed
    if (t === "RUN_STARTED") return true; // a start with no later finish/error
  }
  return false; // no run markers at all
}
