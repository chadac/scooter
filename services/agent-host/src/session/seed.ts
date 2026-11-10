/** Session seeds: parent context a new child session starts with. */

import type { SummaryTurn } from "@scooter/claude-sdk-provider";

import type { AguiEvent } from "../bridge.js";
import { foldTurns } from "../agent/transcript.js";

/** Summarizer input cap, matching the history preamble's budget. */
export const SEED_INPUT_MAX_CHARS = 48_000;
/** Seed cap, so a long summary can't crowd context. */
export const SEED_MAX_CHARS = 8_000;

const TRIMMED = "\n\n…(summary trimmed)";

export type SeedEvent = Extract<AguiEvent, { type: "SESSION_SEED" }>;

/** Summarizer turns: tools as assistant text, platform events as user. */
export function summaryTurns(events: AguiEvent[]): SummaryTurn[] {
  return foldTurns(events).map((t) =>
    t.role === "tool"
      ? { role: "assistant", text: t.text }
      : t.role === "system"
        ? { role: "user", text: `[System] ${t.text}` }
        : { role: t.role, text: t.text },
  );
}

/** Newest turns fitting `maxChars`, always keeping the last one. */
export function newestWithin(turns: SummaryTurn[], maxChars: number): SummaryTurn[] {
  let used = 0;
  let start = turns.length;
  while (start > 0) {
    const len = turns[start - 1].text.length;
    if (start < turns.length && used + len > maxChars) break;
    used += len;
    start--;
  }
  const kept = turns.slice(start);
  // A single oversized turn keeps its newest end.
  if (kept.length === 1 && kept[0].text.length > maxChars) {
    return [{ ...kept[0], text: kept[0].text.slice(-maxChars) }];
  }
  return kept;
}

/** Seed text for a parent's history; null when it's empty. */
export async function buildSummarySeed(
  history: AguiEvent[],
  summarize: (turns: SummaryTurn[]) => Promise<string>,
): Promise<{ text: string; summarizedTurns: number } | null> {
  const turns = newestWithin(summaryTurns(history), SEED_INPUT_MAX_CHARS);
  if (turns.length === 0) return null;
  const summary = (await summarize(turns)).trim();
  if (!summary) throw new Error("summarizer returned no text");
  const text =
    summary.length > SEED_MAX_CHARS ? summary.slice(0, SEED_MAX_CHARS - TRIMMED.length) + TRIMMED : summary;
  return { text, summarizedTurns: turns.length };
}

/** The recap turn a SESSION_SEED becomes in the child's history. */
export function seedRecapTurn(seed: SeedEvent, index: number): AguiEvent[] {
  const mid = `seed-${index}`;
  const header = `[Context from the parent conversation "${seed.parentTitle}", as of when this session was forked]`;
  return [
    { type: "TEXT_MESSAGE_START", messageId: mid, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: mid, delta: `${header}\n${seed.text}` },
    { type: "TEXT_MESSAGE_END", messageId: mid },
  ];
}

/** Swap each SESSION_SEED for its recap turn before folding. */
export function expandSeeds(events: AguiEvent[]): AguiEvent[] {
  if (!events.some((e) => e.type === "SESSION_SEED")) return events;
  return events.flatMap((e, i) => (e.type === "SESSION_SEED" ? seedRecapTurn(e, i) : [e]));
}

/** Fake-agent summarizer, so e2e forks without a model. */
export async function fakeSeedSummary(_conversationId: string, turns: SummaryTurn[]): Promise<string> {
  return [`Summary of ${turns.length} turns:`, ...turns.map((t) => `- ${t.role}: ${t.text.slice(0, 80)}`)].join("\n");
}
