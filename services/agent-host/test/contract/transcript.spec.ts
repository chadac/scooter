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

  // Was "caps from the oldest end": the transcript is now SELECTED under a budget
  // rather than tail-sliced, so an over-budget log keeps the opening AND the newest
  // turn and marks whatever it had to drop. Why: PR #652.
  it("bounds an over-budget transcript, keeps the newest turn, and marks what it dropped", () => {
    const big = "x".repeat(20_000);
    const out = buildHistoryPreamble([...userTurn("u1", big), ...userTurn("u2", "recent")], 5_000);
    expect(out).toMatch(/omitted/); // the truncation is signalled, not silent
    expect(out).toContain("recent"); // the most recent turn is kept
    expect(out.length).toBeLessThan(6_000);
  });

  it("includes every turn and NO elision marker when the log fits the budget", () => {
    const out = buildHistoryPreamble([...userTurn("u1", "the objective"), ...userTurn("u2", "recent")], 5_000);
    expect(out).toContain("User: the objective");
    expect(out).toContain("User: recent");
    expect(out).not.toContain("omitted");
  });

  // The bug this pins: a conversation states its objective ONCE, at the top. A
  // tail-only window kept the recent chatter and dropped the goal, so a session
  // dropped mid-conversation resumed on the last tactical detail and had to be
  // told what it had been doing all along. Why: PR #652.
  it("PINS the opening turn when the tail alone would have evicted it", () => {
    const log = [
      ...userTurn("u1", "THE OBJECTIVE: make the e2e suite pass"),
      ...asstTurn("a1", "filler ".repeat(1_000)),
      ...userTurn("u2", "that's weird, it's not printing"),
    ];
    const out = buildHistoryPreamble(log, 2_000);
    expect(out).toContain("THE OBJECTIVE"); // the head is pinned
    expect(out).toContain("that's weird"); // the newest turn still makes it
    expect(out).toContain("earlier messages omitted"); // the middle is marked, not silent
  });

  it("clips — rather than drops — an opening turn that alone exceeds the head budget", () => {
    const log = [...userTurn("u1", "OBJECTIVE " + "x".repeat(20_000)), ...userTurn("u2", "recent")];
    const out = buildHistoryPreamble(log, 2_000);
    expect(out).toContain("User: OBJECTIVE xxx"); // a truncated objective still orients
    expect(out).toContain("recent");
  });

  it("budgets the tool record separately so it can't evict the user/assistant turns", () => {
    // 60 tool turns of ~900 chars each (~54k) followed by the turns that carry intent.
    // Unbudgeted, the newest-first walk spends the whole window on `Tool:` lines.
    const tools: AguiEvent[] = [];
    for (let i = 0; i < 60; i++) {
      tools.push(
        { type: "TOOL_CALL_START", toolCallId: `c${i}`, toolCallName: "bash" },
        { type: "TOOL_CALL_ARGS", toolCallId: `c${i}`, delta: `{"cmd":"${"z".repeat(400)}"}` },
        { type: "TOOL_CALL_END", toolCallId: `c${i}` },
        { type: "TOOL_CALL_RESULT", toolCallId: `c${i}`, messageId: `m${i}`, content: "y".repeat(400) },
      );
    }
    const log = [
      ...userTurn("u1", "THE OBJECTIVE"),
      ...tools,
      ...asstTurn("a1", "here is what I found"),
      ...userTurn("u2", "and my latest instruction"),
    ];
    const out = buildHistoryPreamble(log, 10_000);
    expect(out).toContain("THE OBJECTIVE");
    expect(out).toContain("here is what I found");
    expect(out).toContain("and my latest instruction");
    // Tool turns are present but bounded — they may not take the whole window.
    expect(out).toContain("Tool: bash(");
    const toolChars = out.split("\n\n").filter((l) => l.startsWith("Tool: ")).join("").length;
    expect(toolChars).toBeLessThan(6_000);
  });

  it("still carries the NEWEST turn when it alone exceeds the budget (clipped, not dropped)", () => {
    const log = [...userTurn("u1", "THE OBJECTIVE"), ...asstTurn("a1", "R".repeat(20_000) + " THE LATEST STATE")];
    const out = buildHistoryPreamble(log, 5_000);
    expect(out).toContain("THE OBJECTIVE");
    expect(out).toContain("THE LATEST STATE"); // the tail of the runaway turn survives
  });

  it("skips a single runaway turn rather than everything older than it", () => {
    const log = [
      ...userTurn("u1", "THE OBJECTIVE"),
      ...asstTurn("a1", "a useful middle turn"),
      ...asstTurn("a2", "R".repeat(9_000)), // alone bigger than the tail budget
      ...userTurn("u2", "latest"),
    ];
    const out = buildHistoryPreamble(log, 5_000);
    expect(out).toContain("THE OBJECTIVE");
    expect(out).toContain("a useful middle turn"); // survived despite the runaway after it
    expect(out).toContain("latest");
    expect(out).not.toContain("RRRR");
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
