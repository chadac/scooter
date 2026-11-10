/**
 * Session seeds: summarizing a parent for a new session, and the seed reaching the
 * session's first prompt as a recap turn.
 */

import { describe, it, expect, vi } from "vitest";

import { buildSummarySeed, expandSeeds, newestWithin, SEED_INPUT_MAX_CHARS, SEED_MAX_CHARS } from "../../src/session/seed.js";
import { historyAfterCompaction, compactConversation } from "../../src/session/compaction.js";
import { buildHistoryPreamble } from "../../src/agent/transcript.js";
import type { AguiEvent } from "../../src/bridge.js";

const msg = (id: string, role: "user" | "assistant", text: string): AguiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];

const seed = (text = "THE RECAP"): AguiEvent => ({
  type: "SESSION_SEED", mode: "summary", parentId: "p1", parentTitle: "Fix the login", text, summarizedTurns: 3,
});

describe("newestWithin", () => {
  const turns = [1, 2, 3].map((i) => ({ role: "user" as const, text: "x".repeat(10) + i }));

  it("keeps the newest turns that fit", () => {
    expect(newestWithin(turns, 25).map((t) => t.text.at(-1))).toEqual(["2", "3"]);
  });

  it("keeps the newest end of one oversized turn", () => {
    expect(newestWithin([{ role: "user", text: "abcdef" }], 3)).toEqual([{ role: "user", text: "def" }]);
  });
});

describe("buildSummarySeed", () => {
  it("summarizes the folded turns, tool calls included", async () => {
    const summarize = vi.fn(async () => "  recap  ");
    const history: AguiEvent[] = [
      ...msg("u1", "user", "deploy it"),
      { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      ...msg("a1", "assistant", "deployed"),
    ];
    expect(await buildSummarySeed(history, summarize)).toEqual({ text: "recap", summarizedTurns: 3 });
    expect(summarize).toHaveBeenCalledWith([
      { role: "user", text: "deploy it" },
      { role: "assistant", text: "bash" },
      { role: "assistant", text: "deployed" },
    ]);
  });

  it("sends at most the input budget, newest first", async () => {
    const summarize = vi.fn(async () => "r");
    const big = "y".repeat(SEED_INPUT_MAX_CHARS / 2);
    await buildSummarySeed([...msg("1", "user", "OLDEST"), ...msg("2", "user", big), ...msg("3", "user", big)], summarize);
    const sent = summarize.mock.calls[0][0] as Array<{ text: string }>;
    expect(sent.map((t) => t.text).join("")).not.toContain("OLDEST");
  });

  it("summarizes a compacted parent from its recap onward", async () => {
    const summarize = vi.fn(async () => "r");
    const log: AguiEvent[] = [
      ...msg("u1", "user", "ancient"),
      { type: "COMPACTION_MARKER", summary: "EARLIER", summarizedTurns: 1, keptRuns: 1 },
      ...msg("u2", "user", "recent"),
    ];
    await buildSummarySeed(historyAfterCompaction(log), summarize);
    const sent = (summarize.mock.calls[0][0] as Array<{ text: string }>).map((t) => t.text).join("\n");
    expect(sent).toContain("EARLIER");
    expect(sent).toContain("recent");
    expect(sent).not.toContain("ancient");
  });

  it("caps a long summary with a marker", async () => {
    const out = await buildSummarySeed(msg("u", "user", "q"), async () => "z".repeat(SEED_MAX_CHARS * 2));
    expect(out!.text.length).toBe(SEED_MAX_CHARS);
    expect(out!.text).toMatch(/summary trimmed\)$/);
  });

  it("is null for an empty parent and throws on an empty summary", async () => {
    expect(await buildSummarySeed([], async () => "r")).toBeNull();
    await expect(buildSummarySeed(msg("u", "user", "q"), async () => " ")).rejects.toThrow();
  });
});

describe("a seeded session's history", () => {
  it("opens the first prompt's preamble with the parent's recap", () => {
    const preamble = buildHistoryPreamble(historyAfterCompaction([seed()]));
    expect(preamble).toContain('[Context from the parent conversation "Fix the login"');
    expect(preamble).toContain("THE RECAP");
  });

  it("keeps the seed ahead of the session's own turns", () => {
    const out = historyAfterCompaction([seed(), ...msg("u1", "user", "now try B")]);
    expect(out.some((e) => e.type === "SESSION_SEED")).toBe(false);
    const preamble = buildHistoryPreamble(out);
    expect(preamble.indexOf("THE RECAP")).toBeLessThan(preamble.indexOf("now try B"));
  });

  it("is folded into a later compaction's summary", async () => {
    const runs: AguiEvent[] = [];
    for (let i = 1; i <= 6; i++) {
      runs.push({ type: "RUN_STARTED", threadId: "s", runId: `r${i}` }, ...msg(`u${i}`, "user", `q${i}`), { type: "RUN_FINISHED", threadId: "s", runId: `r${i}` });
    }
    const summarize = vi.fn(async () => "R");
    const store = {
      async *readEvents() { yield* [seed(), ...runs]; },
      appendEvent: async () => {},
    } as never;
    await compactConversation(store, "s", { model: "m", oauthToken: "t", summarize });
    expect((summarize.mock.calls[0][0] as Array<{ text: string }>)[0].text).toContain("THE RECAP");
  });

  it("leaves a log without seeds untouched", () => {
    const log = msg("u", "user", "q");
    expect(expandSeeds(log)).toBe(log);
  });
});
