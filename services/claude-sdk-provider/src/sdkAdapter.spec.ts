/**
 * Tier 1 contract test — Claude Agent SDK message → bridge SessionUpdate mapping.
 *
 * The claude-code provider (SDK-backed) must produce the SAME normalized
 * SessionUpdates the goose ACP path does, so the bridge/AG-UI mapping is
 * unchanged. This mirrors bridge.spec.ts's ACP→AG-UI mapping — the highest-value
 * test for a new provider. Pure function, no SDK runtime.
 */

import { describe, it, expect } from "vitest";

import { sdkMessageToUpdates, SANDBOX_MCP_PREFIX, type SdkMessage } from "./sdkAdapter.js";

describe("sdkMessageToUpdates", () => {
  // With partials OFF, the assistant message is the ONLY source of text/thinking.
  it("maps an assistant text block to agent_message_chunk (partials off)", () => {
    const msg: SdkMessage = { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
    expect(sdkMessageToUpdates(msg, false)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    ]);
  });

  it("maps a thinking block to agent_thought_chunk (partials off)", () => {
    const msg: SdkMessage = { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } };
    expect(sdkMessageToUpdates(msg, false)).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    ]);
  });

  // REGRESSION (double-send): with partials ON (our default), text + thinking arrive
  // as stream_event deltas, so the final assistant message must NOT re-emit them —
  // else every reply is sent twice. tool_use etc. are still emitted from it.
  it("does NOT re-emit assistant text/thinking when partials are on (no double-send)", () => {
    const msg: SdkMessage = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }, { type: "thinking", thinking: "hmm" }] },
    };
    expect(sdkMessageToUpdates(msg /* partialsEnabled defaults true */)).toEqual([]);
  });

  it("emits text/thinking ONCE via stream_event deltas (the live path)", () => {
    const textDelta: SdkMessage = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } } as SdkMessage;
    expect(sdkMessageToUpdates(textDelta)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hel" } },
    ]);
  });

  it("still emits tool_use from the assistant message even with partials on", () => {
    const msg: SdkMessage = {
      type: "assistant",
      message: { content: [{ type: "text", text: "running" }, { type: "tool_use", id: "tu_x", name: `${SANDBOX_MCP_PREFIX}bash`, input: { command: "ls" } }] },
    };
    // text skipped (deltas cover it), tool_use kept (not a delta).
    expect(sdkMessageToUpdates(msg)).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "tu_x", title: "bash", rawInput: { command: "ls" } },
    ]);
  });

  it("maps a sandbox tool_use to a tool_call, stripping the mcp__sandbox__ prefix from the title", () => {
    const msg: SdkMessage = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu_1", name: `${SANDBOX_MCP_PREFIX}bash`, input: { command: "ls" } }] },
    };
    expect(sdkMessageToUpdates(msg)).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "tu_1", title: "bash", rawInput: { command: "ls" } },
    ]);
  });

  it("maps a successful tool_result to a completed tool_call_update carrying rawOutput", () => {
    const msg: SdkMessage = {
      type: "assistant",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file1\nfile2" }] },
    };
    expect(sdkMessageToUpdates(msg)).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "tu_1", status: "completed", rawOutput: "file1\nfile2" },
    ]);
  });

  it("maps an errored tool_result to a failed tool_call_update", () => {
    const msg: SdkMessage = {
      type: "assistant",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "boom", is_error: true }] },
    };
    expect(sdkMessageToUpdates(msg)[0]).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "tu_2", status: "failed" });
  });

  it("maps an image block to an agent_message_chunk image", () => {
    const msg: SdkMessage = {
      type: "assistant",
      message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
    };
    expect(sdkMessageToUpdates(msg)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
    ]);
  });

  it("emits multiple updates for a mixed assistant turn, in order", () => {
    const msg: SdkMessage = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll run it." },
          { type: "tool_use", id: "tu_3", name: `${SANDBOX_MCP_PREFIX}bash`, input: { command: "uname" } },
        ],
      },
    };
    // partials ON (default): text is skipped (deltas cover it), tool_call kept.
    expect(sdkMessageToUpdates(msg).map((u) => u.sessionUpdate)).toEqual(["tool_call"]);
    // partials OFF: both, in order.
    expect(sdkMessageToUpdates(msg, false).map((u) => u.sessionUpdate)).toEqual(["agent_message_chunk", "tool_call"]);
  });

  it("maps a streaming text_delta to agent_message_chunk", () => {
    const msg: SdkMessage = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "wor" } } };
    expect(sdkMessageToUpdates(msg)).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wor" } },
    ]);
  });

  it("maps a streaming thinking_delta to agent_thought_chunk", () => {
    const msg: SdkMessage = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "th" } } };
    expect(sdkMessageToUpdates(msg)).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "th" } },
    ]);
  });

  it("yields [] for a result message (the client resolves stopReason, not the adapter)", () => {
    expect(sdkMessageToUpdates({ type: "result", subtype: "success" } as SdkMessage)).toEqual([]);
  });

  it("ignores unknown message and block types (forward-compatible)", () => {
    expect(sdkMessageToUpdates({ type: "system", subtype: "init" } as SdkMessage)).toEqual([]);
    const weird: SdkMessage = { type: "assistant", message: { content: [{ type: "future_block", data: 1 }] } };
    expect(sdkMessageToUpdates(weird)).toEqual([]);
  });

  it("drops empty text (no zero-length chunks)", () => {
    const msg: SdkMessage = { type: "assistant", message: { content: [{ type: "text", text: "" }] } };
    expect(sdkMessageToUpdates(msg)).toEqual([]);
  });
});
