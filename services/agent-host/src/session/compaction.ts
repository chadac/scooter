/**
 * Manual conversation compaction: summarize the older part of a long conversation and
 * continue on [summary + the recent turns] to recover context window. The log is split
 * on run boundaries keeping the most recent ~30% of runs verbatim, the older turns are
 * summarized by a one-off tool-less SDK query (any failure throws and leaves the
 * conversation unchanged), and a COMPACTION_MARKER event carrying the summary is
 * persisted so loadHistory seeds a revived session from [summary + events after the
 * marker]. Non-destructive: the old events stay in the log and only the agent's resumed
 * context shrinks.
 */

import { summarizeConversation, type SummaryTurn } from "@scooter/claude-sdk-provider";

import type { AguiEvent } from "../bridge.js";
import type { ConversationStore } from "./manager.js";
import { expandSeeds, summaryTurns } from "./seed.js";
import { splitByRuns, runCount } from "./eventWindow.js";

/** Fraction of the most-recent runs to keep verbatim (the rest is summarized). */
export const COMPACT_KEEP_FRACTION = 0.3;
/** Never keep fewer than this many recent runs verbatim. */
export const COMPACT_MIN_KEEP_RUNS = 2;
/** Do not compact with fewer runs than this. */
export const COMPACT_MIN_TOTAL_RUNS = 4;

export interface CompactionDeps {
  /** The conversation's model, used for the summary too. */
  model: string;
  /** Subscription token for the summarizer (CLAUDE_CODE_OAUTH_TOKEN). */
  oauthToken: string;
  /** glibc `claude` path for the summarizer (defaults to CLAUDE_CODE_COMMAND / claude). */
  claudeCodePath?: string;
  /** Injectable summarizer for tests; defaults to the real SDK one-off. */
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
 * Summarize the older turns and persist a COMPACTION_MARKER, returning null when there is
 * too little to compact and throwing if summarization fails; the caller revives afterwards.
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

  // A seeded session's recap is part of what gets summarized.
  const oldTurns = summaryTurns(expandSeeds(older));
  if (oldTurns.length === 0) return null; // no summarizable content

  const summarize =
    deps.summarize ??
    ((turns: SummaryTurn[]) =>
      summarizeConversation(turns, { model: deps.model, oauthToken: deps.oauthToken, claudeCodePath: deps.claudeCodePath }));

  // Throws on failure, leaving the conversation as-is.
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
 * The history a revived session resumes from: everything after the latest
 * COMPACTION_MARKER with the marker replaced by an assistant recap turn, or the full log
 * when there is no marker. A session seed becomes a recap turn too.
 */
export function historyAfterCompaction(logged: AguiEvent[]): AguiEvent[] {
  const events = expandSeeds(logged);
  let lastMarker = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "COMPACTION_MARKER") lastMarker = i;
  }
  if (lastMarker < 0) return events;

  const marker = events[lastMarker] as Extract<AguiEvent, { type: "COMPACTION_MARKER" }>;
  const after = events.slice(lastMarker + 1);
  // A single assistant turn, so foldTurns/buildHistoryPreamble pick it up as prior context.
  const mid = `compaction-${lastMarker}`;
  const recapTurn: AguiEvent[] = [
    { type: "TEXT_MESSAGE_START", messageId: mid, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: mid, delta: `[Recap of earlier conversation]\n${marker.summary}` },
    { type: "TEXT_MESSAGE_END", messageId: mid },
  ];
  return [...recapTurn, ...after];
}
