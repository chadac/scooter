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
 * We fold ONLY the user + assistant TEXT_MESSAGE_* turns. Tool calls, reasoning,
 * permission and run-control events are skipped: they reference session-scoped
 * state (tool ids, terminals) that no longer exists in the new session, and would
 * only bloat the prompt. A plain "User:/Assistant:" transcript is what a fresh
 * model needs to continue coherently.
 */

import type { AguiEvent } from "../bridge.js";

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Fold a persisted event log into ordered user/assistant turns. Streams of
 * TEXT_MESSAGE_START(role) → CONTENT(delta)* → END(messageId) become one turn
 * each, concatenating the deltas. Events for other types are ignored. Empty
 * turns (no content) are dropped.
 */
export function foldTurns(events: Iterable<AguiEvent>): TranscriptTurn[] {
  const role = new Map<string, "user" | "assistant">();
  const buf = new Map<string, string>();
  const turns: TranscriptTurn[] = [];
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
      default:
        break;
    }
  }
  return turns;
}

/**
 * Build the history preamble to prepend to the first prompt after a revive.
 * Returns "" when there are no prior turns (a brand-new conversation, or a log
 * with only the current message excluded upstream) — the caller then prepends
 * nothing. `maxChars` caps the transcript from the OLDEST end (keeps the most
 * recent turns, which matter most) so a long conversation can't blow the prompt.
 */
export function buildHistoryPreamble(events: Iterable<AguiEvent>, maxChars = 12_000): string {
  const turns = foldTurns(events);
  if (turns.length === 0) return "";

  const lines = turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
  let body = lines.join("\n\n");
  if (body.length > maxChars) {
    // Trim from the front (oldest), keep the tail; mark the elision.
    body = "…(earlier messages omitted)…\n\n" + body.slice(body.length - maxChars);
  }
  return (
    "[Previous conversation — this session was resumed and you have no memory of it. " +
    "Continue from here; do NOT re-introduce yourself or repeat prior work.]\n\n" +
    body +
    "\n\n[End of previous conversation. The user's new message follows.]"
  );
}
