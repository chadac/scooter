/**
 * Fold an event log into AG-UI `Message`s for a MESSAGES_SNAPSHOT.
 *
 * Replaying history as individual events makes the client's applier rebuild the
 * message list token by token, deep-cloning the whole array on every emit — O(n²)
 * on a long conversation. A snapshot applies the same history in ONE pass.
 */

import { EventType } from "@ag-ui/core";
import type { AguiEvent } from "../bridge.js";

/** Event types the client's applier routes through its message-mutation path: it
 *  deep-clones the whole message array to emit each one. A replay must skip them,
 *  or the client rebuilds — token by token — the list the snapshot just delivered.
 *
 *  Derived from the library's own enum so a new upstream event type cannot
 *  silently reintroduce the O(n^2) replay. `MESSAGES_SNAPSHOT` is excluded: it is
 *  what we send, not something we skip. */
export const MESSAGE_EVENTS: ReadonlySet<string> = new Set(
  Object.values(EventType).filter(
    (t) => t !== EventType.MESSAGES_SNAPSHOT && /MESSAGE|REASONING|TOOL_CALL|TEXT|THINKING/.test(t),
  ),
);

export interface SnapshotMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "reasoning";
  content: string;
  toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  toolCallId?: string;
}

/** Fold `events` into messages in emission order. */
export function foldToMessages(events: Iterable<AguiEvent>): SnapshotMessage[] {
  const out: SnapshotMessage[] = [];
  const byId = new Map<string, SnapshotMessage>();
  // A tool call belongs to the assistant message open when it started.
  const toolToAssistant = new Map<string, SnapshotMessage>();
  const toolName = new Map<string, string>();
  const toolArgs = new Map<string, string>();
  let openAssistant: SnapshotMessage | undefined;

  const open = (id: string, role: SnapshotMessage["role"]) => {
    const m: SnapshotMessage = { id, role, content: "" };
    byId.set(id, m);
    out.push(m);
    return m;
  };

  for (const e of events as Iterable<Record<string, string>>) {
    switch (e.type) {
      case "TEXT_MESSAGE_START": {
        const role = e.role === "user" ? "user" : "assistant";
        const m = open(e.messageId, role);
        if (role === "assistant") openAssistant = m;
        break;
      }
      case "REASONING_START":
      case "REASONING_MESSAGE_START":
        open(e.messageId, "reasoning");
        break;
      case "TEXT_MESSAGE_END":
        // Close the assistant turn: a tool call that starts AFTER it belongs to the
        // next turn, not this one. Without this every tool call in the conversation
        // attaches to the last-opened assistant message (89 on one message in a real
        // log), and a windowed fold of the same log disagrees with the whole-log fold.
        if (openAssistant?.id === e.messageId) openAssistant = undefined;
        break;
      case "TEXT_MESSAGE_CONTENT":
      case "REASONING_MESSAGE_CONTENT": {
        // CONTENT with no preceding START: a log can begin mid-message (a truncated
        // run, or a window that starts inside one). Open the message rather than drop
        // the text — losing a user's turn is the worse failure.
        const m =
          byId.get(e.messageId) ??
          open(e.messageId, e.type === "REASONING_MESSAGE_CONTENT" ? "reasoning" : "assistant");
        m.content += e.delta ?? "";
        break;
      }
      case "TOOL_CALL_START": {
        toolName.set(e.toolCallId, e.toolCallName ?? "");
        if (openAssistant) toolToAssistant.set(e.toolCallId, openAssistant);
        break;
      }
      case "TOOL_CALL_ARGS":
        toolArgs.set(e.toolCallId, (toolArgs.get(e.toolCallId) ?? "") + (e.delta ?? ""));
        break;
      case "TOOL_CALL_END": {
        const host = toolToAssistant.get(e.toolCallId) ?? openAssistant;
        const call = {
          id: e.toolCallId,
          type: "function" as const,
          function: { name: toolName.get(e.toolCallId) ?? "", arguments: toolArgs.get(e.toolCallId) ?? "" },
        };
        if (host) (host.toolCalls ??= []).push(call);
        else {
          // A tool call with no open assistant message still needs a carrier, or its
          // result below would reference a toolCallId the client never saw.
          const m = open(`asst-${e.toolCallId}`, "assistant");
          m.toolCalls = [call];
        }
        break;
      }
      case "TOOL_CALL_RESULT": {
        // A result whose START/END never made it into the log (an interrupted run
        // truncates mid-call) would reference a toolCallId no message declares — the
        // client renders that as a dangling card. Synthesize the carrier.
        if (!toolName.has(e.toolCallId)) {
          const host = openAssistant ?? open(`asst-${e.toolCallId}`, "assistant");
          (host.toolCalls ??= []).push({
            id: e.toolCallId,
            type: "function",
            function: { name: "", arguments: "" },
          });
          toolName.set(e.toolCallId, "");
        }
        const m = open(`tool-${e.toolCallId}`, "tool");
        m.toolCallId = e.toolCallId;
        m.content = e.content ?? "";
        break;
      }
      default:
        break; // RUN_*, QUEUE_UPDATED, CONTEXT_USAGE, SYSTEM_MESSAGE: not messages
    }
  }
  // Drop framing that produced nothing renderable (an opened-but-empty message).
  return out.filter((m) => m.content !== "" || (m.toolCalls?.length ?? 0) > 0 || m.role === "tool");
}
