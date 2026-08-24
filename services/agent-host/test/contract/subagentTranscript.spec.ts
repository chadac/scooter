/**
 * Tier 1 — the subagent transcript builder. Folds a persisted AG-UI event log into
 * ordered turns INCLUDING compact tool-call summaries, so a parent monitoring a
 * subagent sees what it DID (tools) as well as what it SAID (text) — the point is
 * spotting divergence. See todo/done/SUBAGENT_INTERACTION.md.
 */

import { describe, it, expect } from "vitest";

import { foldTurnsWithTools, type SubagentTurn } from "../../src/agent/subagentTranscript.js";
import type { AguiEvent } from "../../src/bridge.js";

const ev = (e: Record<string, unknown>) => e as unknown as AguiEvent;

describe("foldTurnsWithTools", () => {
  it("folds user + assistant TEXT_MESSAGE turns (concatenating deltas)", () => {
    const turns = foldTurnsWithTools([
      ev({ type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "find the " }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "auth bug" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "u1" }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "on it" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
    ]);
    expect(turns).toEqual<SubagentTurn[]>([
      { role: "user", text: "find the auth bug" },
      { role: "assistant", text: "on it" },
    ]);
  });

  it("emits a compact tool-call summary in order (name + a short arg preview)", () => {
    const turns = foldTurnsWithTools([
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "let me grep" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
      ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" }),
      ev({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"command":"grep -r foo src"}' }),
    ]);
    expect(turns[0]).toEqual({ role: "assistant", text: "let me grep" });
    const tool = turns[1];
    expect(tool.role).toBe("tool");
    expect(tool.text).toContain("bash");
    expect(tool.text).toContain("grep -r foo src");
  });

  it("preserves interleaved order (text -> tool -> text)", () => {
    const turns = foldTurnsWithTools([
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "step 1" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
      ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "read" }),
      ev({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"path":"a.ts"}' }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: "done" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "a2" }),
    ]);
    expect(turns.map((t) => t.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(turns.map((t) => t.text)).toEqual(["step 1", expect.stringContaining("read"), "done"]);
  });

  it("skips RUN_* / QUEUE_UPDATED / CONTEXT_USAGE framing (non-conversational)", () => {
    const turns = foldTurnsWithTools([
      ev({ type: "RUN_STARTED", runId: "r1" }),
      ev({ type: "QUEUE_UPDATED", items: [] }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "hi" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
      ev({ type: "CONTEXT_USAGE", usedTokens: 10, contextWindow: 100 }),
      ev({ type: "RUN_FINISHED", runId: "r1" }),
    ]);
    expect(turns).toEqual([{ role: "assistant", text: "hi" }]);
  });

  it("drops empty text turns; a tool with no args still summarizes by name", () => {
    const turns = foldTurnsWithTools([
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "a1" }), // empty → dropped
      ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "list_dir" }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: "tool" });
    expect(turns[0].text).toContain("list_dir");
  });
});
