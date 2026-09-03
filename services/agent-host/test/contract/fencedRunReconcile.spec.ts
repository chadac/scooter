/**
 * Tier 1 — why a run truncated by an ownership fence is never reconciled.
 *
 * Live evidence (valhalla, 2026-09-02, conversation 9cb8bd61):
 *   - agent-host rolled out 10 times; the controller reassigned the conversation
 *     each time (generation 2 -> 11)
 *   - the outgoing pod's fence dropped 1,100 events INCLUDING the terminal
 *   - `reconcileDanglingRun` logged "nothing to settle" on every adopt, having
 *     read the WHOLE log (events_seen=10917) — so it is not reading a short tail
 *   - the conversation ended with 12 "acp prompt: sending" and 9 "returned"
 *
 * These tests pin the mechanism so a fix can be judged against it.
 */

import { describe, it, expect } from "vitest";

import { danglingRunInfo } from "../../src/session/danglingRun.js";
import type { AguiEvent } from "../../src/bridge.js";

const ev = (o: Record<string, unknown>) => o as unknown as AguiEvent;
const SELF = { host: "agent-host-5799784b7c-5hnz5", gen: 11 };

/** A run the fence truncated: RUN_STARTED + content, no terminal. */
const truncatedRun = (runId: string): AguiEvent[] => [
  ev({ type: "RUN_STARTED", threadId: "c", runId }),
  ev({ type: "TEXT_MESSAGE_START", messageId: `m-${runId}`, role: "assistant" }),
  ev({ type: "TEXT_MESSAGE_CONTENT", messageId: `m-${runId}`, delta: "working" }),
];

/** A run that completed normally. */
const completeRun = (runId: string): AguiEvent[] => [
  ev({ type: "RUN_STARTED", threadId: "c", runId }),
  ev({ type: "TEXT_MESSAGE_CONTENT", messageId: `m-${runId}`, delta: "done" }),
  ev({ type: "RUN_FINISHED", threadId: "c", runId }),
];

describe("a fence-truncated run, alone at the tail", () => {
  it("IS detected — the simple case works", () => {
    expect(danglingRunInfo(truncatedRun("fenced"), SELF)).toMatchObject({ runId: "fenced" });
  });
});

describe("a fence-truncated run followed by a later COMPLETED run", () => {
  // This is the shape production actually produces. The fence truncates the run
  // in flight; the user (or the resume path) then prompts again on the NEW owner
  // and that run completes normally. The log now holds an orphan RUN_STARTED
  // BELOW a RUN_FINISHED.
  const log = [...truncatedRun("fenced"), ...completeRun("later")];

  it("is INVISIBLE to danglingRunInfo — it stops at the first terminal from the end", () => {
    // The scan returns null on the first RUN_FINISHED/RUN_ERROR it meets going
    // backwards, so the orphan below it is never reached. This is why every
    // production check logged "nothing to settle" despite reading 10,917 events.
    expect(danglingRunInfo(log, SELF)).toBeNull();
  });

  it("the orphan is really there — the log is NOT self-consistent", () => {
    // What the UI replays: a RUN_STARTED with no matching terminal. Its `running`
    // flag is a boolean, so this reads as "still running" forever.
    const started = log.filter((e) => e.type === "RUN_STARTED").map((e) => (e as { runId: string }).runId);
    const ended = new Set(
      log.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR")
        .map((e) => (e as { runId?: string }).runId),
    );
    expect(started.filter((r) => !ended.has(r))).toEqual(["fenced"]);
  });

  it("stays invisible however many complete runs pile on top", () => {
    // Each subsequent turn buries it further — the conversation never self-heals.
    const deep = [...truncatedRun("fenced"), ...completeRun("a"), ...completeRun("b"), ...completeRun("c")];
    expect(danglingRunInfo(deep, SELF)).toBeNull();
  });
});

describe("isOwnRun is not the cause", () => {
  it("RUN_STARTED carries no host/gen in production, so a foreign run is not skipped", () => {
    // bridge.ts emits `{ type: "RUN_STARTED", threadId, runId }` — host and gen are
    // optional on the type and never populated. isOwnRun therefore returns false
    // (unknown origin -> foreign), so it cannot be what suppresses detection.
    const noOrigin = truncatedRun("fenced");
    expect(danglingRunInfo(noOrigin, SELF)).not.toBeNull();
    // Even claiming to be the same pod at the same generation only matters when the
    // event actually carries that origin:
    const withOrigin = [ev({ type: "RUN_STARTED", threadId: "c", runId: "r", host: SELF.host, gen: SELF.gen })];
    expect(danglingRunInfo(withOrigin, SELF)).toBeNull();
  });
});
