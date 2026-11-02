/**
 * Claude Agent SDK to bridge SessionUpdate adapter. It maps one SDK message to the
 * bridge's normalized `SessionUpdate[]`, the same shape the goose ACP path emits via
 * normalizeUpdate(), so the bridge, AG-UI mapping and metrics are shared. The mapping
 * is pure (no SDK runtime) and is the contract test's target.
 */

import type { SessionUpdate, ContentBlock } from "./types.js";

/** Minimal structural shapes of the SDK messages this adapter reads, kept local so the mapping is testable without the SDK package. */
export type SdkContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
// The union is kept closed so `switch (block.type)` discriminates; unknown block types fall to the default case.

export type SdkMessage =
  | { type: "assistant"; message: { content: SdkContentBlock[] } }
  | { type: "stream_event"; event: SdkStreamEvent }
  | { type: "result"; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** The subset of streaming events surfaced as deltas. */
export type SdkStreamEvent =
  | { type: "content_block_delta"; delta: { type: "text_delta"; text: string } }
  | { type: "content_block_delta"; delta: { type: "thinking_delta"; thinking: string } }
  | { type: string; [k: string]: unknown };

/** The tool-name prefix of the in-process sandbox MCP server; must match createSandboxMcpServer's name. */
export const SANDBOX_MCP_PREFIX = "mcp__sandbox__";

/** Human title for a sandbox tool_use, without the mcp__sandbox__ prefix. */
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

/** Normalize image blocks in a tool result to the ACP/MCP `{type:"image", data, mimeType}` shape. The
 *  bridge moves the bytes into the conversation's asset store and keeps only a reference in the log,
 *  so the UI's tool card can show the image without carrying base64 in history. */
export function normalizeResultImages(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((b) => {
    if (!b || typeof b !== "object" || (b as { type?: unknown }).type !== "image") return b;
    // Accept both the Messages-API shape (source.data) and the MCP shape (data/mimeType).
    const img = b as { data?: string; mimeType?: string; source?: { data?: string; media_type?: string } };
    const data = img.source?.data ?? img.data;
    const mimeType = img.source?.media_type ?? img.mimeType;
    if (typeof data !== "string" || typeof mimeType !== "string") return { type: "text", text: "[image]" };
    return { type: "image", data, mimeType };
  });
}

/** Map one message's content[] blocks to session updates, shared by the `assistant` case and the `user` case that carries tool_result blocks. */
function blocksToUpdates(content: SdkContentBlock[], partialsEnabled: boolean): SessionUpdate[] {
  const out: SessionUpdate[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        // When partials are on the stream_event deltas already emitted this text.
        if (block.text && !partialsEnabled) out.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
        break;
      case "thinking":
        if (block.thinking && !partialsEnabled) out.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
        break;
      case "tool_use":
        // rawInput carries the command/args so the UI's tool card is not empty.
        out.push({ sessionUpdate: "tool_call", toolCallId: block.id, title: toolTitle(block.name), rawInput: block.input });
        break;
      case "tool_result": {
        // The structured result rides the update so the UI can show it.
        out.push({
          sessionUpdate: "tool_call_update",
          toolCallId: block.tool_use_id,
          status: block.is_error ? "failed" : "completed",
          rawOutput: normalizeResultImages(block.content),
        });
        break;
      }
      case "image": {
        const img = imageBlock(block as Extract<SdkContentBlock, { type: "image" }>);
        if (img) out.push({ sessionUpdate: "agent_message_chunk", content: img });
        break;
      }
      default:
        break; // unknown block type
    }
  }
  return out;
}

/**
 * Map one SDK message to zero or more normalized SessionUpdates; "result" yields []
 * because the client handles the terminal reason. With `partialsEnabled`, text and
 * thinking already arrived as `stream_event` deltas, so the final `assistant` message
 * must not re-emit them.
 */
export function sdkMessageToUpdates(msg: SdkMessage, partialsEnabled = true): SessionUpdate[] {
  switch (msg.type) {
    case "assistant":
      return blocksToUpdates((msg as { message?: { content?: SdkContentBlock[] } }).message?.content ?? [], partialsEnabled);

    // A `user` message carries the tool_result blocks of a tool the agent called.
    case "user":
      return blocksToUpdates((msg as { message?: { content?: SdkContentBlock[] } }).message?.content ?? [], partialsEnabled);

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
