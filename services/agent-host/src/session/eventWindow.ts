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
  // Index of each RUN_STARTED.
  const starts: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "RUN_STARTED") starts.push(i);
  }
  if (starts.length <= runs) return events.slice(starts[0] ?? 0);
  // Slice from the RUN_STARTED that begins the last `runs` runs.
  return events.slice(starts[starts.length - runs]);
}
