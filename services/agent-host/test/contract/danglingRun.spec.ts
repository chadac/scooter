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
