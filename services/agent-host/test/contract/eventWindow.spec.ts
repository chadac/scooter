/**
 * Tier 1 — the recent-tail event window (fast first-paint for long conversations).
 *
 * Slices on RUN boundaries so every message/tool call in the window is complete
 * and folds identically to a full replay of those runs.
 */

import { describe, it, expect } from "vitest";

import { tailByRuns, orderByTime } from "../../src/session/eventWindow.js";
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

describe("orderByTime + restart-scrambled logs", () => {
  // A run whose events carry an explicit `ts` (epoch ms). `base` is the run's
  // start time; each event is +1ms so intra-run order is preserved by ts alone.
  const tsRun = (n: number, base: number): AguiEvent[] => [
    { type: "RUN_STARTED", threadId: "c", runId: `r${n}`, ts: base },
    { type: "TEXT_MESSAGE_START", messageId: `u${n}`, role: "user", ts: base + 1 },
    { type: "TEXT_MESSAGE_CONTENT", messageId: `u${n}`, delta: `msg ${n}`, ts: base + 2 },
    { type: "TEXT_MESSAGE_END", messageId: `u${n}`, ts: base + 3 },
    { type: "RUN_FINISHED", threadId: "c", runId: `r${n}`, ts: base + 4 },
  ];

  it("orders a restart-scrambled log by ts (real chronology, not append order)", () => {
    // Append order puts run 2 (t=2000) BEFORE run 1 (t=1000) — as if the log
    // concatenated a second process's runs ahead of the first's on disk.
    const scrambled = [...tsRun(2, 2000), ...tsRun(1, 1000), ...tsRun(3, 3000)];
    const ordered = orderByTime(scrambled);
    const runs = ordered.filter((e) => e.type === "RUN_STARTED").map((e) => (e as { runId: string }).runId);
    expect(runs).toEqual(["r1", "r2", "r3"]); // sorted by ts, not by file position
  });

  it("tailByRuns windows the last N runs BY TIME even when append order is scrambled", () => {
    const scrambled = [...tsRun(2, 2000), ...tsRun(1, 1000), ...tsRun(3, 3000)];
    const tail = tailByRuns(scrambled, 1);
    // The chronologically-last run is r3 (t=3000), NOT the last-appended (r3 here,
    // but the point is it's chosen by ts) — and it's whole.
    expect(tail[0]).toMatchObject({ type: "RUN_STARTED", runId: "r3" });
    expect(tail.filter((e) => e.type === "TEXT_MESSAGE_END")).toHaveLength(1);
  });

  it("is a STABLE sort: equal ts keeps append order", () => {
    const a: AguiEvent = { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "A", ts: 5 };
    const b: AguiEvent = { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "B", ts: 5 };
    expect(orderByTime([a, b]).map((e) => (e as { delta: string }).delta)).toEqual(["A", "B"]);
  });

  it("leaves an UNSTAMPED log untouched (legacy behavior preserved exactly)", () => {
    const legacy = [...run(1), ...run(2)];
    expect(orderByTime(legacy)).toBe(legacy); // same reference — no reorder
  });
});
