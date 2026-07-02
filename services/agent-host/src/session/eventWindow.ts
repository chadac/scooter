/**
 * Window a persisted AG-UI event log to its RECENT tail — for fast first-paint
 * when opening a long conversation.
 *
 * The UI folds events into messages (fromAgUiMessages), so a naive "last N events"
 * slice could start mid-message (a TEXT_MESSAGE_CONTENT with no START) and fold
 * into a broken message. We instead slice on RUN boundaries: a RUN_STARTED begins
 * a self-contained unit (the user's turn + the assistant's full response, incl.
 * tool calls + reasoning), so keeping whole runs guarantees every message and
 * tool call in the window is complete.
 *
 * Returns the events from the last `runs` RUN_STARTED markers onward (plus any
 * leading events before the first RUN_STARTED are dropped — they belong to older
 * runs). The tail folds identically to a full replay of those same runs, so the
 * UI can paint it now and then reconcile against the full integrity stream with no
 * visible change.
 */

import type { AguiEvent } from "../bridge.js";

/**
 * Keep the events belonging to the last `runs` runs. `runs <= 0` returns []. If
 * there are fewer than `runs` RUN_STARTED markers, the whole log is returned.
 */
export function tailByRuns(events: AguiEvent[], runs: number): AguiEvent[] {
  if (runs <= 0) return [];
  const ordered = orderByTime(events);
  // Index of each RUN_STARTED.
  const starts: number[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].type === "RUN_STARTED") starts.push(i);
  }
  if (starts.length <= runs) return ordered.slice(starts[0] ?? 0);
  // Slice from the RUN_STARTED that begins the last `runs` runs.
  return ordered.slice(starts[starts.length - runs]);
}

/**
 * STABLE-sort a log by each event's `ts` (epoch ms, stamped at emit). This makes
 * the tail window robust when append order diverges from real time — e.g. a
 * conversation that survived agent-host restarts, whose log concatenates runs from
 * separate processes. The sort is stable (ties keep append order) and events with
 * no `ts` (synthetic/legacy) keep their original position relative to their
 * neighbors, so a fully-unstamped log is returned unchanged. Exported for reuse.
 */
export function orderByTime(events: AguiEvent[]): AguiEvent[] {
  // Fast path: nothing stamped → don't reorder (preserves legacy behavior exactly).
  if (!events.some((e) => typeof e.ts === "number")) return events;
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const ta = a.event.ts;
      const tb = b.event.ts;
      // Missing ts sorts as its neighbor (use index) so it never jumps the log.
      if (typeof ta === "number" && typeof tb === "number" && ta !== tb) return ta - tb;
      return a.index - b.index; // stable tie-break: keep append order
    })
    .map((x) => x.event);
}
