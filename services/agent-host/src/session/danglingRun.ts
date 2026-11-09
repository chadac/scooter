/**
 * Detect an interrupted conversation from its event log. A run is a RUN_STARTED …
 * RUN_FINISHED|RUN_ERROR unit; if the agent-host dies mid-run the last RUN_STARTED never
 * gets its terminal, and on restart such conversations are resumed with a nudge. Scanning
 * from the end, a terminal seen before any RUN_STARTED means the last run completed, and
 * a RUN_STARTED seen first means it is dangling.
 */

import type { AguiEvent, AguiInterrupt } from "../bridge.js";

/**
 * True iff the conversation's last run started but never finished and was not started by
 * `self`, so a run this pod is still executing is not mistaken for a stranded one.
 */
export function hasDanglingRun(events: AguiEvent[], self?: RunOrigin): boolean {
  return danglingRunInfo(events, self) !== null;
}

/** The dangling run's identity plus whether the user asked to stop it before the old host died,
 *  which decides between resuming it and marking it terminal. */
export interface DanglingRunInfo {
  runId: string;
  threadId: string;
  cancelRequested: boolean;
  /** The pod that started it, when the event recorded one. */
  host?: string;
}

export function danglingRunInfo(events: AguiEvent[], self?: RunOrigin): DanglingRunInfo | null {
  let cancelled: string | undefined; // runId named by a CANCEL_REQUESTED seen in the tail
  // Terminals end their own run, so closing an older orphan can't hide the latest.
  const ended = new Set<string>();
  let endedUnnamed = false; // a terminal without a runId ends the latest run
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") {
      const runId = (e as { runId?: string }).runId;
      if (runId) ended.add(runId);
      else endedUnnamed = true;
      continue;
    }
    if (e.type === "CANCEL_REQUESTED") cancelled = e.runId;
    if (e.type === "RUN_STARTED") {
      if (endedUnnamed || ended.has(e.runId)) return null; // last run completed
      if (isOwnRun(e, self)) return null;
      return { runId: e.runId, threadId: e.threadId, cancelRequested: cancelled === e.runId, host: e.host };
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
 * True iff `started` was begun by the caller, so it is in flight rather than stranded;
 * conservative, since no caller identity or no origin on the event reads as dangling.
 */
export function isOwnRun(started: { host?: string; gen?: number }, self?: RunOrigin): boolean {
  if (!self || started.host === undefined) return false; // unknown origin -> treat as foreign
  if (started.host !== self.host) return false; // a different pod started it
  // Same pod, earlier generation: the conversation was reassigned away and back, so that run is
  // stranded.
  if (self.gen !== undefined && started.gen !== undefined && started.gen < self.gen) return false;
  return true;
}

/**
 * True iff the conversation has run at least once and its last run completed; the
 * completion signal for the subagent watcher, robust to a run that starts and finishes
 * between ticks.
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
 * Every run in `events` with a RUN_STARTED and no terminal, oldest first, excluding runs
 * `self` is still executing; unlike danglingRunInfo this finds an orphan buried under a
 * later completed run, which a fenced hand-off leaves behind.
 */
export function orphanRuns(events: AguiEvent[], self?: RunOrigin): OrphanRun[] {
  const started = new Map<string, { threadId: string; own: boolean }>();
  const ended = new Set<string>();
  let latest: string | undefined;
  for (const e of events) {
    const runId = (e as { runId?: string }).runId;
    if (e.type === "RUN_STARTED" && runId) {
      latest = runId;
      started.set(runId, {
        threadId: String((e as { threadId?: string }).threadId ?? ""),
        own: isOwnRun(e as { host?: string; gen?: number }, self),
      });
    } else if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") {
      // The bridge's RUN_ERROR carries no runId; it ends the latest run.
      const id = runId ?? latest;
      if (id) ended.add(id);
    }
  }
  return [...started]
    .filter(([runId, v]) => !ended.has(runId) && !v.own)
    .map(([runId, v]) => ({ runId, threadId: v.threadId }));
}

/** True iff the log raised interrupt `id` and never settled it. */
export function isUnansweredInterrupt(events: AguiEvent[], id: string): boolean {
  return unansweredInterrupt(events, id) !== undefined;
}

/** The latest raise of interrupt `id`, unless something settled it since. */
export function unansweredInterrupt(events: AguiEvent[], id: string): AguiInterrupt | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "PERMISSION_RESOLVED" && e.toolCallId === id) return undefined;
    if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
      const raised = e.outcome.interrupts.find((x) => x.id === id);
      if (raised) return raised;
    }
  }
  return undefined;
}

/** The only event types danglingRunInfo and orphanRuns read. */
export const RUN_MARKER_TYPES: readonly string[] = ["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "CANCEL_REQUESTED"];
