/**
 * Tier 1 — detect an interrupted (dangling) run from the event-log tail.
 *
 * A run is RUN_STARTED … RUN_FINISHED|RUN_ERROR. If the last RUN_STARTED has no
 * later finish/error, the process died mid-run → dangling → resume on boot.
 */

import { describe, it, expect } from "vitest";

import { hasDanglingRun, lastRunCompleted } from "../../src/session/danglingRun.js";
import type { AguiEvent } from "../../src/bridge.js";

const started = (r: string): AguiEvent => ({ type: "RUN_STARTED", threadId: "c", runId: r });
const finished = (r: string): AguiEvent => ({ type: "RUN_FINISHED", threadId: "c", runId: r });
const errored = (r: string): AguiEvent => ({ type: "RUN_ERROR", message: "boom", code: "x" } as AguiEvent);
const text = (): AguiEvent => ({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hi" });

describe("hasDanglingRun", () => {
  it("true when the last run started but never finished", () => {
    expect(hasDanglingRun([started("r1"), finished("r1"), started("r2"), text()])).toBe(true);
  });

  it("false when the last run completed (finished)", () => {
    expect(hasDanglingRun([started("r1"), text(), finished("r1")])).toBe(false);
  });

  it("false when the last run errored (a real failure, not an interruption)", () => {
    expect(hasDanglingRun([started("r1"), text(), errored("r1")])).toBe(false);
  });

  it("false for an empty log or one with no run markers", () => {
    expect(hasDanglingRun([])).toBe(false);
    expect(hasDanglingRun([text()])).toBe(false);
  });

  it("true when a mid-conversation run dangles at the very end", () => {
    expect(hasDanglingRun([started("r1"), finished("r1"), started("r2"), text(), text()])).toBe(true);
  });
});

describe("lastRunCompleted (subagent completion signal)", () => {
  it("true when a run started and finished (the fast-run-between-ticks case)", () => {
    // The bug: a subagent run that starts + finishes within one watcher interval.
    // The event log still shows the completion, so this must be true.
    expect(lastRunCompleted([started("r1"), text(), finished("r1")])).toBe(true);
  });

  it("true when the run errored (still a completed run to report)", () => {
    expect(lastRunCompleted([started("r1"), errored("r1")])).toBe(true);
  });

  it("false while a run is still in flight (dangling — not done yet)", () => {
    expect(lastRunCompleted([started("r1"), text()])).toBe(false);
    // A finished run followed by a NEW in-flight run: not complete yet.
    expect(lastRunCompleted([started("r1"), finished("r1"), started("r2"), text()])).toBe(false);
  });

  it("false when there are no runs yet (just spawned, hasn't started)", () => {
    expect(lastRunCompleted([])).toBe(false);
    expect(lastRunCompleted([text()])).toBe(false);
  });
});

/**
 * Tier 1 — a dangling run must be attributed to a HOST, not just detected.
 *
 * Regression guard for the production bug where revive-on-assign nudged a
 * conversation's OWN live first run: the controller pushes revive on every Assign
 * (including a brand-new conversation's first), and the predicate could not tell a
 * run this pod started 1.8s ago from one a drained pod left behind. The user saw
 * "[System: interrupted by a restart…]" during their first message.
 */
const startedBy = (r: string, host?: string, gen?: number): AguiEvent =>
  ({ type: "RUN_STARTED", threadId: "c", runId: r, host, gen }) as AguiEvent;

describe("hasDanglingRun — run ownership", () => {
  const self = { host: "agent-host-0", gen: 5 };

  it("a run THIS pod started is in flight, NOT dangling", () => {
    // The bug: without `self` this returns true and the live run gets a resume nudge.
    expect(hasDanglingRun([startedBy("r1", "agent-host-0", 5)], self)).toBe(false);
  });

  it("a run ANOTHER pod started is stranded → dangling", () => {
    expect(hasDanglingRun([startedBy("r1", "agent-host-9", 5)], self)).toBe(true);
  });

  it("a run this pod started at an EARLIER generation is stranded", () => {
    // Reassigned away and back: same pod name, older assignment — genuinely orphaned.
    expect(hasDanglingRun([startedBy("r1", "agent-host-0", 4)], self)).toBe(true);
  });

  it("an UNSTAMPED run (persisted before origin existed) stays dangling", () => {
    // Conservative: unknown origin reads as foreign, preserving the pre-fix behaviour
    // rather than silently skipping a resume a rollout depends on.
    expect(hasDanglingRun([startedBy("r1")], self)).toBe(true);
  });

  it("with NO caller identity (single-replica) every dangling run still resumes", () => {
    expect(hasDanglingRun([startedBy("r1", "agent-host-0", 5)])).toBe(true);
  });

  it("a COMPLETED run is never dangling, whoever started it", () => {
    expect(hasDanglingRun([startedBy("r1", "agent-host-9", 4), finished("r1")], self)).toBe(false);
  });
});
