/**
 * Tier 1 — the revive history transcript builder.
 *
 * Folds a persisted AG-UI log into user/assistant turns and formats the preamble
 * that gets prepended to the first prompt of a revived (memory-less) goose
 * session. Only TEXT_MESSAGE_* turns; tool/reasoning/run events are ignored.
 */

import { describe, it, expect } from "vitest";

import { foldTurns, buildHistoryPreamble } from "../../src/agent/transcript.js";
import type { AguiEvent } from "../../src/bridge.js";

const userTurn = (id: string, text: string): AguiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "user" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];
const asstTurn = (id: string, ...deltas: string[]): AguiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
  ...deltas.map((d) => ({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: d }) as AguiEvent),
  { type: "TEXT_MESSAGE_END", messageId: id },
];

describe("transcript: foldTurns", () => {
  it("folds alternating user/assistant turns in order, concatenating deltas", () => {
    const log = [
      ...userTurn("u1", "hello"),
      ...asstTurn("a1", "hi ", "there"),
      ...userTurn("u2", "do X"),
    ];
    expect(foldTurns(log)).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
      { role: "user", text: "do X" },
    ]);
  });

  it("ignores tool/reasoning/run events entirely", () => {
    const log: AguiEvent[] = [
      ...userTurn("u1", "run ls"),
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "bash" },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"cmd":"ls"}' },
      { type: "TOOL_CALL_END", toolCallId: "c1" },
      { type: "REASONING_START", messageId: "z1" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: "z1", delta: "thinking" },
      { type: "REASONING_END", messageId: "z1" },
      ...asstTurn("a1", "done"),
      { type: "RUN_FINISHED", threadId: "t", runId: "r" },
    ];
    expect(foldTurns(log)).toEqual([
      { role: "user", text: "run ls" },
      { role: "assistant", text: "done" },
    ]);
  });

  it("drops empty turns (a START/END with no content)", () => {
    const log: AguiEvent[] = [
      { type: "TEXT_MESSAGE_START", messageId: "e", role: "assistant" },
      { type: "TEXT_MESSAGE_END", messageId: "e" },
      ...userTurn("u1", "hi"),
    ];
    expect(foldTurns(log)).toEqual([{ role: "user", text: "hi" }]);
  });
});

describe("transcript: buildHistoryPreamble", () => {
  it("returns '' for an empty log (fresh conversation → no prepend)", () => {
    expect(buildHistoryPreamble([])).toBe("");
  });

  it("formats User:/Assistant: lines wrapped in resume framing", () => {
    const out = buildHistoryPreamble([...userTurn("u1", "hello"), ...asstTurn("a1", "hi")]);
    expect(out).toContain("User: hello");
    expect(out).toContain("Assistant: hi");
    expect(out).toMatch(/resumed/i);
    expect(out).toMatch(/new message follows/i);
  });

  it("caps a very long transcript from the oldest end and marks the elision", () => {
    const big = "x".repeat(20_000);
    const out = buildHistoryPreamble([...userTurn("u1", big), ...userTurn("u2", "recent")], 5_000);
    expect(out).toContain("earlier messages omitted");
    expect(out).toContain("recent"); // the most recent turn is kept
    expect(out.length).toBeLessThan(6_000);
  });
});
