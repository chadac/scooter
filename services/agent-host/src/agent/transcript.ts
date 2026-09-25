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

/** Fraction of the budget reserved for the conversation's OPENING turns. The task
 *  is stated at the top and never restated; a tail-only window drops it. Why: PR #652. */
export const HEAD_BUDGET_FRACTION = 0.2;
/** Fraction of the remaining budget the `Tool:` record may occupy. Tool turns vastly
 *  outnumber human ones, so an unbudgeted record evicts the conversation it is
 *  supposed to annotate. Why: PR #652. */
export const TOOL_BUDGET_FRACTION = 0.5;

/** Marks a gap where whole turns were dropped to fit the budget. */
const ELISION = "…(earlier messages omitted)…";
/** Marks the END of a turn clipped to fit (its beginning was kept). */
const CLIPPED_TAIL = " …(rest of this message omitted)…";
/** Marks the START of a turn clipped to fit (its end was kept). */
const CLIPPED_HEAD = "…(earlier part of this message omitted)… ";

/**
 * Build the history preamble to prepend to the first prompt after a revive.
 * Returns "" when there are no prior turns (a brand-new conversation, or a log
 * with only the current message excluded upstream) — the caller then prepends
 * nothing.
 *
 * `maxChars` bounds the transcript. Under budget, every turn is included in order.
 * OVER budget the turns are SELECTED, not tail-sliced:
 *
 *   1. The opening non-tool turns are PINNED (up to HEAD_BUDGET_FRACTION of the
 *      budget). A conversation states its objective once, at the top; a tail-only
 *      window keeps the recent chatter and drops the goal, so the agent resumes
 *      working on the last tactical detail and has to be told what it was doing.
 *   2. The newest turn is guaranteed (clipped if need be) — the state the agent is
 *      standing in.
 *   3. The rest is filled from the NEWEST end backwards, with tool turns limited
 *      to TOOL_BUDGET_FRACTION of that remainder — so a tool-heavy stretch cannot
 *      evict the user/assistant turns that carry intent. A turn that doesn't fit
 *      its budget is skipped and the walk continues, so one runaway turn costs
 *      itself rather than everything older than it.
 *
 * The budget is generous: this history is the ONLY continuity a revive or a
 * deliberate mid-work model switch has (the fresh session starts blank), so
 * under-injecting silently strands the user's work. Individual tool args/results
 * are already clipped in foldTurns, so the budget bounds the TRANSCRIPT, not any
 * one runaway turn. Framing and elision markers sit outside it.
 */
export function buildHistoryPreamble(events: Iterable<AguiEvent>, maxChars = 48_000): string {
  const turns = foldTurns(events);
  if (turns.length === 0) return "";

  const lines = turns.map((t) => `${ROLE_LABEL[t.role]}: ${t.text}`);
  const SEP = "\n\n";
  const cost = (i: number) => lines[i].length + SEP.length;
  const total = lines.reduce((n, l) => n + l.length + SEP.length, 0) - SEP.length;

  let body: string;
  if (total <= maxChars) {
    body = lines.join(SEP);
  } else {
    const keep = new Set<number>();

    // (1) HEAD — the opening user/assistant turns, where the objective lives. Tool
    // turns are skipped here: the first turns of a conversation are usually the
    // agent's opening exploration, which would spend the whole head budget on
    // `Tool:` lines and drop the very message they were exploring for.
    const headBudget = Math.floor(maxChars * HEAD_BUDGET_FRACTION);
    let spent = 0;
    for (let i = 0; i < lines.length; i++) {
      if (turns[i].role === "tool") continue;
      if (keep.size === 0 && cost(i) > headBudget) {
        // The opening turn ALONE blows the head budget. Clip it rather than drop it —
        // a truncated objective still orients the agent; no objective does not.
        const room = headBudget - SEP.length - CLIPPED_TAIL.length;
        lines[i] = lines[i].slice(0, Math.max(0, room)) + CLIPPED_TAIL;
      } else if (spent + cost(i) > headBudget) {
        break;
      }
      keep.add(i);
      spent += cost(i);
    }

    // (2) The NEWEST turn is GUARANTEED, clipped if it alone exceeds what is left:
    // resuming without the state the agent is standing in is worse than resuming
    // without the objective. The size-based skip below would otherwise drop a single
    // runaway final turn outright — the one turn that must never be dropped.
    let room = maxChars - spent;
    const last = lines.length - 1;
    if (!keep.has(last)) {
      if (cost(last) > room) {
        const fits = Math.max(0, room - SEP.length - CLIPPED_HEAD.length);
        lines[last] = CLIPPED_HEAD + lines[last].slice(lines[last].length - fits);
      }
      keep.add(last);
      room = Math.max(0, room - cost(last));
    }

    // (3) TAIL — newest first, so the most recent turns win the remaining room. A
    // tool turn spends BOTH budgets; a user/assistant turn spends only `room`, which
    // is what reserves at least (1 - TOOL_BUDGET_FRACTION) of the tail for the
    // conversation itself. A turn that doesn't fit is SKIPPED and the walk continues,
    // so one runaway turn costs itself rather than everything older than it.
    let toolRoom = Math.floor(room * TOOL_BUDGET_FRACTION);
    for (let i = last - 1; i >= 0; i--) {
      if (keep.has(i)) continue;
      const c = cost(i);
      if (c > room) continue;
      if (turns[i].role === "tool") {
        if (c > toolRoom) continue;
        toolRoom -= c;
      }
      keep.add(i);
      room -= c;
    }

    // Render what survived in ORIGINAL order, marking gaps so the agent reads the
    // history as partial rather than complete. A gap of ONLY tool turns is NOT marked:
    // `Tool:` lines are a lossy annotation of work, not messages, and marking each
    // skipped one buries the transcript in markers. Why: PR #652.
    const lostAMessage = (from: number, to: number) => {
      for (let i = from; i <= to; i++) if (turns[i].role !== "tool") return true;
      return false;
    };
    const parts: string[] = [];
    let prev = -1;
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (i !== prev + 1 && lostAMessage(prev + 1, i - 1)) parts.push(ELISION);
      parts.push(lines[i]);
      prev = i;
    }
    body = parts.join(SEP);
  }

  return (
    "[Previous conversation — this session was resumed and you have no memory of it. " +
    "Continue from here; do NOT re-introduce yourself or repeat prior work. Lines prefixed " +
    "`Tool:` record work already done (a tool call and its result).]\n\n" +
    body +
    "\n\n[End of previous conversation. The user's new message follows.]"
  );
}
