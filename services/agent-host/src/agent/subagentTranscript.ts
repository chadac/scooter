/**
 * Subagent transcript builder — folds a persisted AG-UI event log into ordered
 * turns INCLUDING compact tool-call summaries, so a parent monitoring a subagent
 * sees what it DID (tools) as well as what it SAID (text). Used by
 * monitor_subagent (tail) + search_subagent (filter). See
 *
 * Distinct from agent/transcript.ts's `foldTurns` (text-only, for the revive
 * preamble) — here tool calls matter, since divergence is often in the actions.
 */

import type { AguiEvent } from "../bridge.js";

export interface SubagentTurn {
  /** "user"/"assistant" for a text turn; "tool" for a tool-call summary line. */
  role: "user" | "assistant" | "tool";
  text: string;
}

/** Max chars of a tool's args preview in the summary (keeps lines readable). */
const TOOL_ARG_PREVIEW = 60;

/** A compact one-line summary for a tool call: `ran <name>` + a short arg preview
 *  (the command / first meaningful field), so the parent sees WHAT it ran. */
function toolSummary(name: string, rawArgs: string): string {
  const args = rawArgs.trim();
  let preview = "";
  if (args) {
    // Prefer a `command`/`path`/`query` field if the args are JSON; else the raw.
    try {
      const obj = JSON.parse(args) as Record<string, unknown>;
      const pick = obj.command ?? obj.path ?? obj.query ?? obj.subagent_id ?? Object.values(obj)[0];
      preview = typeof pick === "string" ? pick : JSON.stringify(pick ?? obj);
    } catch {
      preview = args;
    }
    preview = preview.replace(/\s+/g, " ").trim();
    if (preview.length > TOOL_ARG_PREVIEW) preview = preview.slice(0, TOOL_ARG_PREVIEW) + "…";
  }
  return preview ? `ran ${name} \`${preview}\`` : `ran ${name}`;
}

/**
 * Fold an event log into ordered turns: user/assistant TEXT_MESSAGE_* become one
 * turn each (concatenated deltas; empty dropped), and each TOOL_CALL_START (with
 * its TOOL_CALL_ARGS, if any) becomes a compact `tool` summary line, in emission
 * order. RUN_* / QUEUE_UPDATED / CONTEXT_USAGE / reasoning framing is skipped.
 */
export function foldTurnsWithTools(events: Iterable<AguiEvent>): SubagentTurn[] {
  const textRole = new Map<string, "user" | "assistant">();
  const textBuf = new Map<string, string>();
  const toolName = new Map<string, string>();
  const toolArgs = new Map<string, string>();
  // A tool summary is emitted when the call is first seen (TOOL_CALL_START); its
  // args may arrive later (TOOL_CALL_ARGS), so we keep the turn's index to patch it.
  const toolTurnIdx = new Map<string, number>();
  const turns: SubagentTurn[] = [];
  for (const e of events) {
    switch (e.type) {
      case "TEXT_MESSAGE_START":
        textRole.set(e.messageId, e.role);
        textBuf.set(e.messageId, "");
        break;
      case "TEXT_MESSAGE_CONTENT": {
        const prev = textBuf.get(e.messageId);
        if (prev !== undefined) textBuf.set(e.messageId, prev + e.delta);
        break;
      }
      case "TEXT_MESSAGE_END": {
        const r = textRole.get(e.messageId);
        const text = (textBuf.get(e.messageId) ?? "").trim();
        if (r && text) turns.push({ role: r, text });
        textRole.delete(e.messageId);
        textBuf.delete(e.messageId);
        break;
      }
      case "TOOL_CALL_START": {
        toolName.set(e.toolCallId, e.toolCallName);
        toolTurnIdx.set(e.toolCallId, turns.length);
        turns.push({ role: "tool", text: toolSummary(e.toolCallName, "") });
        break;
      }
      case "TOOL_CALL_ARGS": {
        const prev = (toolArgs.get(e.toolCallId) ?? "") + e.delta;
        toolArgs.set(e.toolCallId, prev);
        const idx = toolTurnIdx.get(e.toolCallId);
        const name = toolName.get(e.toolCallId);
        if (idx !== undefined && name) turns[idx] = { role: "tool", text: toolSummary(name, prev) };
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

/** Render turns as a readable transcript block (one line per turn). */
export function renderTurns(turns: SubagentTurn[]): string {
  return turns
    .map((t) => (t.role === "tool" ? `  [${t.text}]` : `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`))
    .join("\n");
}
