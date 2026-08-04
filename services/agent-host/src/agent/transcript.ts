/**
 * Reconstruct a plain-text conversation transcript from the persisted AG-UI
 * event log — for REINJECTING history into a freshly-revived goose session.
 *
 * When a conversation is revived (agent-host restart or idle-suspend → resume), a
 * brand-new ACP session is spawned with NO memory of prior turns; ACP's prompt
 * carries only ContentBlock[], with no channel to seed history. So on the first
 * prompt of a revived session the bridge prepends this transcript as a text block
 * ("[Previous conversation]…") ahead of the user's actual message.
 *
 * We fold the user + assistant TEXT_MESSAGE_* turns AND a compact record of the
 * TOOL activity (which tool ran, with what args, and a trimmed result). The tool
 * turns are what carry the actual WORK — files read/written, commands run, their
 * output — so a deliberate mid-session model switch (or any revive) continues
 * with the new model KNOWING what was done, not just the chit-chat around it.
 * Reasoning, permission and run-control events are still skipped: they reference
 * session-scoped state (tool ids, terminals) that no longer exists in the new
 * session and add no continuity value. Long tool args/results are truncated so a
 * tool-heavy history stays token-frugal.
 */

import type { AguiEvent } from "../bridge.js";

export interface TranscriptTurn {
  role: "user" | "assistant" | "tool";
  text: string;
}

/** Per-field truncation for a tool turn's args/result — a long build log or file
 *  dump shouldn't dominate the reinjected history. Whole-transcript capping still
 *  happens in buildHistoryPreamble; this just keeps any single tool turn bounded. */
const TOOL_FIELD_MAX = 800;

function clip(s: string, max = TOOL_FIELD_MAX): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + `… (${t.length - max} more chars)`;
}

/**
 * Fold a persisted event log into ordered turns. Text streams
 * (TEXT_MESSAGE_START(role) → CONTENT(delta)* → END) become one user/assistant
 * turn each. Tool streams (TOOL_CALL_START(name) → ARGS(delta)* → END, and a later
 * TOOL_CALL_RESULT) become one `tool` turn — `name(args) → result` — emitted in
 * call order, interleaved with the text turns. Empty text turns are dropped.
 */
export function foldTurns(events: Iterable<AguiEvent>): TranscriptTurn[] {
  const role = new Map<string, "user" | "assistant">();
  const buf = new Map<string, string>();
  // Tool call accumulators, keyed by toolCallId. `index` is the position in
  // `turns` of this call's placeholder, so a later TOOL_CALL_RESULT can fill it in.
  const tool = new Map<string, { name: string; args: string; index: number }>();
  const turns: TranscriptTurn[] = [];

  const renderTool = (t: { name: string; args: string }, result?: string): string => {
    const args = t.args.trim();
    const head = args ? `${t.name}(${clip(args)})` : t.name;
    return result !== undefined ? `${head} → ${clip(result)}` : head;
  };

  for (const e of events) {
    switch (e.type) {
      case "TEXT_MESSAGE_START":
        role.set(e.messageId, e.role);
        buf.set(e.messageId, "");
        break;
      case "TEXT_MESSAGE_CONTENT": {
        const prev = buf.get(e.messageId);
        if (prev !== undefined) buf.set(e.messageId, prev + e.delta);
        break;
      }
      case "TEXT_MESSAGE_END": {
        const r = role.get(e.messageId);
        const text = (buf.get(e.messageId) ?? "").trim();
        if (r && text) turns.push({ role: r, text });
        role.delete(e.messageId);
        buf.delete(e.messageId);
        break;
      }
      // Tool activity: emit the call in ORDER at START (so it interleaves with text
      // correctly), then backfill the result onto the same turn when it arrives.
      case "TOOL_CALL_START": {
        const entry = { name: e.toolCallName, args: "", index: turns.length };
        tool.set(e.toolCallId, entry);
        turns.push({ role: "tool", text: renderTool(entry) });
        break;
      }
      case "TOOL_CALL_ARGS": {
        const t = tool.get(e.toolCallId);
        if (t) {
          t.args += e.delta;
          turns[t.index] = { role: "tool", text: renderTool(t) };
        }
        break;
      }
      case "TOOL_CALL_RESULT": {
        const t = tool.get(e.toolCallId);
        if (t) turns[t.index] = { role: "tool", text: renderTool(t, e.content) };
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

/** Label for each turn role in the reinjected transcript. */
const ROLE_LABEL: Record<TranscriptTurn["role"], string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

/**
 * Build the history preamble to prepend to the first prompt after a revive.
 * Returns "" when there are no prior turns (a brand-new conversation, or a log
 * with only the current message excluded upstream) — the caller then prepends
 * nothing. `maxChars` caps the transcript from the OLDEST end (keeps the most
 * recent turns, which matter most) so a long conversation can't blow the prompt.
 *
 * The cap is generous: this history is the ONLY continuity a deliberate mid-work
 * model switch has (the new goose session starts blank), so under-injecting silently
 * strands the user's work. Individual tool args/results are already clipped in
 * foldTurns, so a large cap here bounds the TRANSCRIPT, not any one runaway turn.
 */
export function buildHistoryPreamble(events: Iterable<AguiEvent>, maxChars = 48_000): string {
  const turns = foldTurns(events);
  if (turns.length === 0) return "";

  const lines = turns.map((t) => `${ROLE_LABEL[t.role]}: ${t.text}`);
  let body = lines.join("\n\n");
  if (body.length > maxChars) {
    // Trim from the front (oldest), keep the tail; mark the elision.
    body = "…(earlier messages omitted)…\n\n" + body.slice(body.length - maxChars);
  }
  return (
    "[Previous conversation — this session was resumed and you have no memory of it. " +
    "Continue from here; do NOT re-introduce yourself or repeat prior work. Lines prefixed " +
    "`Tool:` record work already done (a tool call and its result).]\n\n" +
    body +
    "\n\n[End of previous conversation. The user's new message follows.]"
  );
}
