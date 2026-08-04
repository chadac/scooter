/**
 * Tier 1 — the revive history transcript builder.
 *
 * Folds a persisted AG-UI log into user/assistant/tool turns and formats the
 * preamble prepended to the first prompt of a revived (memory-less) goose session.
 * TEXT_MESSAGE_* turns AND tool activity (name/args → result) are folded — the tool
 * turns carry the actual work so a model switch continues KNOWING what was done;
 * reasoning/run-control events are still ignored.
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

  it("includes tool activity (name/args → result) in call order, skips reasoning/run events", () => {
    const log: AguiEvent[] = [
      ...userTurn("u1", "run ls"),
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "bash" },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"cmd":' },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '"ls"}' },
      { type: "TOOL_CALL_END", toolCallId: "c1" },
      { type: "TOOL_CALL_RESULT", toolCallId: "c1", messageId: "m1", content: "file-a\nfile-b" },
      { type: "REASONING_START", messageId: "z1" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: "z1", delta: "thinking" },
      { type: "REASONING_END", messageId: "z1" },
      ...asstTurn("a1", "done"),
      { type: "RUN_FINISHED", threadId: "t", runId: "r" },
    ];
    expect(foldTurns(log)).toEqual([
      { role: "user", text: "run ls" },
      { role: "tool", text: 'bash({"cmd":"ls"}) → file-a\nfile-b' },
      { role: "assistant", text: "done" },
    ]);
  });

  it("emits a tool turn even when its result never arrives (name/args only)", () => {
    const log: AguiEvent[] = [
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "read_file" },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"path":"a.ts"}' },
      { type: "TOOL_CALL_END", toolCallId: "c1" },
    ];
    expect(foldTurns(log)).toEqual([{ role: "tool", text: 'read_file({"path":"a.ts"})' }]);
  });

  it("clips a very long tool result so one tool turn can't dominate", () => {
    const huge = "y".repeat(5_000);
    const log: AguiEvent[] = [
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "bash" },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "c1" },
      { type: "TOOL_CALL_RESULT", toolCallId: "c1", messageId: "m1", content: huge },
    ];
    const [t] = foldTurns(log);
    expect(t.role).toBe("tool");
    expect(t.text).toContain("more chars)");
    expect(t.text.length).toBeLessThan(1_000);
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

  it("labels tool turns with a `Tool:` prefix and explains them in the framing", () => {
    const out = buildHistoryPreamble([
      ...userTurn("u1", "read the config"),
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "read_file" },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"path":"cfg.ts"}' },
      { type: "TOOL_CALL_END", toolCallId: "c1" },
      { type: "TOOL_CALL_RESULT", toolCallId: "c1", messageId: "m1", content: "export const x = 1" },
    ]);
    expect(out).toContain('Tool: read_file({"path":"cfg.ts"}) → export const x = 1');
    expect(out).toMatch(/Tool:` record work already done/); // framing tells the model what Tool: means
  });
});
