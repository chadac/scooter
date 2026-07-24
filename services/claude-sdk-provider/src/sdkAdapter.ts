/**
 * Claude Agent SDK → bridge SessionUpdate adapter.
 *
 * The `claude-code` provider drives the agent via `@anthropic-ai/claude-agent-sdk`
 * `query()` (see sdkClient.ts) instead of `goose acp`. That gives us MCP + tool
 * redirection so the agent's shell/file tools run IN THE SANDBOX (not the
 * agent-host pod) while keeping subscription auth — the fix for the claude-code
 * "tools run in the wrong pod, scooter-rebuild unreachable" bug.
 *
 * The SDK yields its own message stream (`SDKMessage`). This module maps ONE SDK
 * message to the bridge's normalized `SessionUpdate[]` — the SAME shape the goose
 * ACP path emits via normalizeUpdate() — so the bridge / AG-UI mapping / metrics
 * are unchanged. This function is PURE (no SDK runtime), so it's the Tier-1
 * contract test's highest-value target, mirroring bridge.spec.ts's ACP mapping.
 *
 * The two content-bearing message kinds:
 *  - "assistant"    : a full BetaMessage turn — its content[] blocks (text /
 *                     tool_use) map to agent_message_chunk / tool_call.
 *  - "stream_event" : an Anthropic streaming event (text/thinking deltas) — maps
 *                     to agent_message_chunk / agent_thought_chunk when partials
 *                     are enabled. Coarser than goose's chunks but same shape.
 *  - "result"       : final; carries usage + the terminal reason (handled by the
 *                     client, not here — it resolves prompt()'s stopReason).
 */

import type { SessionUpdate, ContentBlock } from "./types.js";

/** Minimal structural shapes of the SDK messages this adapter reads. Kept local
 *  (not imported from the SDK) so the pure mapping is testable without the SDK
 *  package, and so a d.ts drift doesn't break the contract test. The real SDK
 *  types (SDKAssistantMessage / SDKPartialAssistantMessage) are a superset. */
export type SdkContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
// (Unknown block types are handled by the `default` case at runtime; keeping the
//  union CLOSED lets `switch (block.type)` discriminate. The SDK's real block
//  type is a superset — we read it structurally via the content[] cast below.)

export type SdkMessage =
  | { type: "assistant"; message: { content: SdkContentBlock[] } }
  | { type: "stream_event"; event: SdkStreamEvent }
  | { type: "result"; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** The subset of Anthropic streaming events we surface as deltas. */
export type SdkStreamEvent =
  | { type: "content_block_delta"; delta: { type: "text_delta"; text: string } }
  | { type: "content_block_delta"; delta: { type: "thinking_delta"; thinking: string } }
  | { type: string; [k: string]: unknown };

/** The tool-name prefix our in-process sandbox MCP server registers under. A
 *  tool_use whose name starts with this ran (or will run) IN THE SANDBOX — the
 *  title the UI shows strips the prefix. Must match createSandboxMcpServer's name. */
export const SANDBOX_MCP_PREFIX = "mcp__sandbox__";

/** Human title for a sandbox tool_use (drops the mcp__sandbox__ prefix). */
function toolTitle(name: string): string {
  return name.startsWith(SANDBOX_MCP_PREFIX) ? name.slice(SANDBOX_MCP_PREFIX.length) : name;
}

/** Map an image content block to the bridge's ContentBlock, or null if unsupported. */
function imageBlock(b: Extract<SdkContentBlock, { type: "image" }>): ContentBlock | null {
  const src = b.source;
  if (src?.type === "base64" && src.data && src.media_type) {
    return { type: "image", data: src.data, mimeType: src.media_type };
  }
  return null;
}

/**
 * Map ONE SDK message to zero-or-more normalized SessionUpdates the bridge
 * consumes. "result" yields [] here (the client handles the terminal reason).
 *
 * `partialsEnabled` — when the query runs with includePartialMessages (our default),
 * TEXT and THINKING already arrive incrementally as `stream_event` deltas, so the
 * final `assistant` message MUST NOT re-emit them or every reply is duplicated (the
 * "message sent twice" bug). tool_use / tool_result / image do NOT come as deltas,
 * so the assistant message is still their only source.
 */
export function sdkMessageToUpdates(msg: SdkMessage, partialsEnabled = true): SessionUpdate[] {
  switch (msg.type) {
    case "assistant": {
      const out: SessionUpdate[] = [];
      const content = (msg as { message?: { content?: SdkContentBlock[] } }).message?.content ?? [];
      for (const block of content) {
        switch (block.type) {
          case "text":
            // Skip when partials are on — the stream_event text_deltas already
            // emitted this text; re-emitting the full block double-sends the reply.
            if (block.text && !partialsEnabled) out.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
            break;
          case "thinking":
            if (block.thinking && !partialsEnabled) out.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
            break;
          case "tool_use":
            // A tool call — its id correlates the later tool_result. rawInput
            // carries the command/args so the UI's tool card isn't empty.
            out.push({ sessionUpdate: "tool_call", toolCallId: block.id, title: toolTitle(block.name), rawInput: block.input });
            break;
          case "tool_result": {
            // The structured result (e.g. a shell's stdout) rides the update so
            // the UI can show it. is_error → a failed status.
            out.push({
              sessionUpdate: "tool_call_update",
              toolCallId: block.tool_use_id,
              status: block.is_error ? "failed" : "completed",
              rawOutput: block.content,
            });
            break;
          }
          case "image": {
            const img = imageBlock(block as Extract<SdkContentBlock, { type: "image" }>);
            if (img) out.push({ sessionUpdate: "agent_message_chunk", content: img });
            break;
          }
          default:
            break; // unknown block type — ignore (forward-compatible)
        }
      }
      return out;
    }

    case "stream_event": {
      const ev = (msg as { event?: SdkStreamEvent }).event;
      if (ev?.type === "content_block_delta") {
        const d = (ev as { delta?: { type?: string; text?: string; thinking?: string } }).delta;
        if (d?.type === "text_delta" && d.text) {
          return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: d.text } }];
        }
        if (d?.type === "thinking_delta" && d.thinking) {
          return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: d.thinking } }];
        }
      }
      return [];
    }

    default:
      return [];
  }
}
