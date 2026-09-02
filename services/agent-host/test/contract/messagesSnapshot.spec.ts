/**
 * Folding an event log into AG-UI messages for MESSAGES_SNAPSHOT.
 *
 * Replaying history event-by-event makes the client's applier rebuild the list
 * token by token, deep-cloning the whole array per emit — 15,062 clones for 4,000
 * events, measured. A snapshot is one pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

import { EventType } from "@ag-ui/core";

import { foldToMessages, MESSAGE_EVENTS } from "../../src/agent/messagesSnapshot.js";
import type { AguiEvent } from "../../src/bridge.js";

const ev = (o: Record<string, unknown>) => o as unknown as AguiEvent;

describe("foldToMessages", () => {
  it("concatenates streamed deltas into one message", () => {
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hel" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "lo" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "m1" }),
    ]);
    expect(out).toEqual([{ id: "m1", role: "assistant", content: "Hello" }]);
  });

  it("keeps user and assistant turns distinct, in order", () => {
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi" }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "hey" }),
    ]);
    expect(out.map((m) => [m.role, m.content])).toEqual([["user", "hi"], ["assistant", "hey"]]);
  });

  it("REASONING becomes a reasoning message — the snapshot carries it, so it is not lost", () => {
    // The applier drops LOCAL reasoning when the snapshot has its own, and keeps it
    // otherwise. Emitting it here means the snapshot is the source of truth.
    const out = foldToMessages([
      ev({ type: "REASONING_START", messageId: "r1" }),
      ev({ type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta: "thinking" }),
      ev({ type: "REASONING_MESSAGE_END", messageId: "r1" }),
    ]);
    expect(out).toEqual([{ id: "r1", role: "reasoning", content: "thinking" }]);
  });

  it("a tool call attaches to its assistant message, and its result is a tool message", () => {
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "running it" }),
      ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" }),
      ev({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"cmd":"ls"}' }),
      ev({ type: "TOOL_CALL_END", toolCallId: "t1" }),
      ev({ type: "TOOL_CALL_RESULT", toolCallId: "t1", content: "a.txt" }),
    ]);
    const asst = out.find((m) => m.id === "a1")!;
    expect(asst.toolCalls).toEqual([
      { id: "t1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
    ]);
    const tool = out.find((m) => m.role === "tool")!;
    expect(tool).toMatchObject({ toolCallId: "t1", content: "a.txt" });
  });

  it("a tool call with no open assistant message still gets a carrier", () => {
    // Otherwise the tool RESULT references a toolCallId the client never saw.
    const out = foldToMessages([
      ev({ type: "TOOL_CALL_START", toolCallId: "t9", toolCallName: "x" }),
      ev({ type: "TOOL_CALL_END", toolCallId: "t9" }),
      ev({ type: "TOOL_CALL_RESULT", toolCallId: "t9", content: "done" }),
    ]);
    expect(out.some((m) => m.role === "assistant" && m.toolCalls?.[0].id === "t9")).toBe(true);
    expect(out.some((m) => m.role === "tool" && m.toolCallId === "t9")).toBe(true);
  });

  it("a RESULT whose START/END are missing entirely still gets a carrier", () => {
    // Found in the real log: one of 746 results had no START and no END — an
    // interrupted run truncated mid-call. Without a synthesized call the client
    // renders a dangling tool card.
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "x" }),
      ev({ type: "TOOL_CALL_RESULT", toolCallId: "orphan", content: "out" }),
    ]);
    const callIds = new Set(out.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
    expect(callIds.has("orphan")).toBe(true);
  });

  it("CONTENT with no preceding START still lands — losing a turn is the worse failure", () => {
    // A log can begin mid-message: a truncated run, or a fire-and-forget append read
    // before its START flushed. Caught by integrityRoute.spec, which appends exactly
    // this shape.
    const out = foldToMessages([ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "do not lose me" })]);
    expect(out).toEqual([{ id: "u1", role: "assistant", content: "do not lose me" }]);
  });

  it("drops framing that renders nothing (RUN_*, QUEUE_UPDATED, empty messages)", () => {
    const out = foldToMessages([
      ev({ type: "RUN_STARTED", threadId: "t", runId: "r" }),
      ev({ type: "QUEUE_UPDATED", items: [] }),
      ev({ type: "CONTEXT_USAGE", usedTokens: 1, contextWindow: 2 }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "empty", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "empty" }),
      ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }),
    ]);
    expect(out).toEqual([]);
  });

  it("THE REAL CONVERSATION: folds 9704 events without losing turns", () => {
    const LOG = "/tmp/claude-1000/-home-chadac-code-github-com-chadac-scooter/b878834b-0733-464c-a5a9-e6f74aa3e41a/scratchpad/events.jsonl";
    if (!existsSync(LOG)) return; // export-dependent; skipped when absent
    const events = readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const out = foldToMessages(events);
    expect(out.length).toBeGreaterThan(100);
    // Every tool result must reference a call the snapshot also carries.
    const callIds = new Set(out.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
    const orphans = out.filter((m) => m.role === "tool" && !callIds.has(m.toolCallId!));
    expect(orphans, "a tool result with no matching call renders as a dangling card").toEqual([]);
  });
});

describe("MESSAGE_EVENTS", () => {
  it("skips every event the applier deep-clones the message array for", () => {
    // The snapshot only pays off if the replay then skips these. One left out —
    // REASONING_END was, and it is 77% of a real log's non-message events — puts
    // the per-event clone right back.
    const mutates = Object.values(EventType).filter(
      (t) => t !== EventType.MESSAGES_SNAPSHOT && /MESSAGE|REASONING|TOOL_CALL|TEXT|THINKING/.test(t),
    );
    expect(mutates.length).toBeGreaterThan(0);
    expect(mutates.filter((t) => !MESSAGE_EVENTS.has(t))).toEqual([]);
  });

  it("still replays events that carry state no snapshot holds", () => {
    for (const t of ["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "RUN_RETRYING",
                     "QUEUE_UPDATED", "CONTEXT_USAGE", "SYSTEM_MESSAGE"]) {
      expect(MESSAGE_EVENTS.has(t)).toBe(false);
    }
  });
});
