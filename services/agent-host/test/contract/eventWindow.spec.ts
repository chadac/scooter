/**
 * Tier 1 — the recent-tail event window (fast first-paint for long conversations).
 *
 * Slices on RUN boundaries so every message/tool call in the window is complete
 * and folds identically to a full replay of those runs.
 */

import { describe, it, expect } from "vitest";

import { tailByRuns } from "../../src/session/eventWindow.js";
import type { AguiEvent } from "../../src/bridge.js";

// A run = RUN_STARTED, a user+assistant message, RUN_FINISHED (marker `n` tags it).
const run = (n: number): AguiEvent[] => [
  { type: "RUN_STARTED", threadId: "c", runId: `r${n}` },
  { type: "TEXT_MESSAGE_START", messageId: `u${n}`, role: "user" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: `u${n}`, delta: `msg ${n}` },
  { type: "TEXT_MESSAGE_END", messageId: `u${n}` },
  { type: "RUN_FINISHED", threadId: "c", runId: `r${n}` },
];

describe("tailByRuns", () => {
  const log = [...run(1), ...run(2), ...run(3), ...run(4)];

  it("keeps the last N runs, whole", () => {
    const tail = tailByRuns(log, 2);
    // Starts at the 3rd RUN_STARTED; contains runs 3 and 4 in full.
    expect(tail[0]).toMatchObject({ type: "RUN_STARTED", runId: "r3" });
    const runsSeen = tail.filter((e) => e.type === "RUN_STARTED").map((e) => (e as { runId: string }).runId);
    expect(runsSeen).toEqual(["r3", "r4"]);
    // Every kept run is complete (START…END present for its message).
    expect(tail.filter((e) => e.type === "TEXT_MESSAGE_START")).toHaveLength(2);
    expect(tail.filter((e) => e.type === "TEXT_MESSAGE_END")).toHaveLength(2);
  });

  it("returns the whole log when there are fewer runs than requested", () => {
    expect(tailByRuns(log, 10)).toEqual(log);
  });

  it("returns [] for runs <= 0", () => {
    expect(tailByRuns(log, 0)).toEqual([]);
    expect(tailByRuns(log, -1)).toEqual([]);
  });

  it("handles an empty log", () => {
    expect(tailByRuns([], 5)).toEqual([]);
  });

  it("never starts mid-message (slice is always a RUN_STARTED)", () => {
    const tail = tailByRuns(log, 1);
    expect(tail[0].type).toBe("RUN_STARTED");
  });
});
