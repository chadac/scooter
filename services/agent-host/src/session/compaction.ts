/**
 * Manual conversation COMPACTION — summarize the older part of a long conversation
 * and continue on [summary + the recent turns], to recover context window.
 *
 * Mechanic (reuses the REVIVE machinery — see manager.revive + index.ts loadHistory):
 *   1. Read the full event log; split it into [older, recent] on RUN boundaries,
 *      keeping the most-recent ~30% of runs verbatim (min a couple of runs).
 *   2. Summarize the OLDER turns via a one-off, tool-less SDK query (same creds/model
 *      the conversation uses). On ANY failure we throw — the caller leaves the
 *      conversation UNCHANGED (no silent context loss).
 *   3. Persist a COMPACTION_MARKER event carrying the summary. It's the durable
 *      compaction point: loadHistory seeds a revived session from [summary + events
 *      AFTER the latest marker], so the fresh session's resumed context is compacted.
 *   4. Revive the conversation (stop the bridge + start a fresh one) so the next turn
 *      runs on the compacted context. The user keeps typing in the SAME thread.
 *
 * Non-destructive: the old events stay in the log (the UI still shows them, with a
 * "Compacted earlier messages" divider); only the AGENT's resumed context shrinks.
 */

import { summarizeConversation, type SummaryTurn } from "@scooter/claude-sdk-provider";

import type { AguiEvent } from "../bridge.js";
import type { ConversationStore } from "./manager.js";
import { foldTurns } from "../agent/transcript.js";
import { splitByRuns, runCount } from "./eventWindow.js";

/** Fraction of the most-recent runs to keep verbatim (the rest is summarized). */
export const COMPACT_KEEP_FRACTION = 0.3;
/** Never keep fewer than this many recent runs verbatim (so a short-ish conversation
 *  still has real recent context, not just a summary). */
export const COMPACT_MIN_KEEP_RUNS = 2;
/** Don't compact unless there are at least this many runs — nothing to gain below it. */
export const COMPACT_MIN_TOTAL_RUNS = 4;

export interface CompactionDeps {
  /** The conversation's model (summarize with the same one). */
  model: string;
  /** Subscription token for the summarizer (CLAUDE_CODE_OAUTH_TOKEN). */
  oauthToken: string;
  /** glibc `claude` path for the summarizer (defaults to CLAUDE_CODE_COMMAND / claude). */
  claudeCodePath?: string;
  /** Injectable summarizer (tests). Defaults to the real SDK one-off. */
  summarize?: (turns: SummaryTurn[]) => Promise<string>;
}

export interface CompactionResult {
  summary: string;
  summarizedTurns: number;
  keptRuns: number;
}

/** How many recent runs to keep verbatim for a log with `total` runs. */
export function keepRunsFor(total: number): number {
  return Math.max(COMPACT_MIN_KEEP_RUNS, Math.ceil(total * COMPACT_KEEP_FRACTION));
}

/**
 * Compact a conversation: summarize the older turns + persist a COMPACTION_MARKER.
 * Returns the result, or null when there's too little to compact. THROWS if
 * summarization fails (the caller then leaves the conversation unchanged).
 *
 * Does NOT revive — the caller (management route) revives after this resolves, so a
 * summarizer failure never disturbs the running conversation.
 */
export async function compactConversation(
  store: ConversationStore,
  conversationId: string,
  deps: CompactionDeps,
): Promise<CompactionResult | null> {
  const events: AguiEvent[] = [];
  for await (const e of store.readEvents(conversationId as never)) events.push(e);

  const total = runCount(events);
  if (total < COMPACT_MIN_TOTAL_RUNS) return null; // not worth compacting yet

  const keptRuns = keepRunsFor(total);
  const { older, recent } = splitByRuns(events, keptRuns);
  if (older.length === 0) return null; // nothing older than the kept tail

  // foldTurns now also emits `tool` turns (name/args → result) so the summary can
  // capture the WORK, not just the chat. The summarizer's SummaryTurn is user|
  // assistant only, so fold a tool turn in as an assistant-side turn (it IS the
  // assistant's action) — the text already carries the tool label.
  const oldTurns: SummaryTurn[] = foldTurns(older).map((t) =>
    t.role === "tool" ? { role: "assistant", text: t.text } : { role: t.role, text: t.text },
  );
  if (oldTurns.length === 0) return null; // no summarizable content

  const summarize =
    deps.summarize ??
    ((turns: SummaryTurn[]) =>
      summarizeConversation(turns, { model: deps.model, oauthToken: deps.oauthToken, claudeCodePath: deps.claudeCodePath }));

  // Throws on failure — propagated to the caller, which leaves the conversation as-is.
  const summary = await summarize(oldTurns);
  if (!summary.trim()) throw new Error("compaction: empty summary");

  await store.appendEvent(conversationId as never, {
    type: "COMPACTION_MARKER",
    summary,
    summarizedTurns: oldTurns.length,
    keptRuns: recent.reduce((n, e) => n + (e.type === "RUN_STARTED" ? 1 : 0), 0),
    ts: Date.now(),
  });

  return { summary, summarizedTurns: oldTurns.length, keptRuns };
}

/**
 * Build the history a revived session should resume from, honoring the LATEST
 * COMPACTION_MARKER: everything from the last marker onward, with the marker replaced
 * by an assistant "recap" turn (so buildHistoryPreamble folds it as prior context).
 * With no marker, returns the full log unchanged (normal revive).
 */
export function historyAfterCompaction(events: AguiEvent[]): AguiEvent[] {
  let lastMarker = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "COMPACTION_MARKER") lastMarker = i;
  }
  if (lastMarker < 0) return events;

  const marker = events[lastMarker] as Extract<AguiEvent, { type: "COMPACTION_MARKER" }>;
  const after = events.slice(lastMarker + 1);
  // Represent the summary as a single assistant turn so foldTurns/buildHistoryPreamble
  // pick it up as prior context ahead of the kept-verbatim recent turns.
  const mid = `compaction-${lastMarker}`;
  const recapTurn: AguiEvent[] = [
    { type: "TEXT_MESSAGE_START", messageId: mid, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: mid, delta: `[Recap of earlier conversation]\n${marker.summary}` },
    { type: "TEXT_MESSAGE_END", messageId: mid },
  ];
  return [...recapTurn, ...after];
}
