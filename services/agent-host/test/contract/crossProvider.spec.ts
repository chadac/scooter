/**
 * Tier 1 — CROSS-PROVIDER consistency, driven by REAL recorded transcripts.
 *
 * Auto-discovers every scenario recorded for BOTH claude and goose and asserts the
 * provider-normalized SessionUpdates are CONSISTENT across providers. Adding a
 * fixture pair extends coverage with no test edit. Where providers diverge, that's
 * a real bug — the harness exists to catch exactly this (the check_subagent
 * back-pressure bug was a provider divergence hidden by fakes).
 *
 * Re-derives updates from the recorded INPUT (claude sdk-in through the LIVE
 * adapter; goose acp-in are already normalized), so it reflects TODAY's code, not
 * the frozen agui-out captured at record time — a fix flips it. See
 * todo/done/AGENT_TRANSCRIPT_HARNESS.md.
 */

import { describe, it, expect } from "vitest";

import { scenariosForAllProviders, providersWith, derivedUpdateTypes, assistantText } from "../support/transcript.js";

const scenarios = scenariosForAllProviders();

// Scenarios whose PROMPT forces a tool call ("run this shell command…"). For these,
// every provider MUST call a tool + surface its result. Open-ended scenarios
// (plain text, multi-turn) let the MODEL decide whether to use a tool — a weak
// local model (llama3.1) may reach for Read/Todo tools where claude just answers;
// that's a model choice, not a code divergence, so we don't assert tool-consistency
// there. (The shape divergences we care about — tool_result dropped, etc. — are
// still caught on the tool-mandatory scenarios.)
const TOOL_MANDATORY = new Set(["shell-tool-and-result", "subagent-poll-loop"]);

describe("cross-provider transcript consistency", () => {
  it("has at least one scenario recorded on both providers", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  describe.each(scenarios)("scenario: %s", (scenario) => {
    const providers = providersWith(scenario);

    it("is recorded for both claude and goose", () => {
      expect(providers.sort()).toEqual(["claude", "goose"]);
    });

    // Only for tool-MANDATORY scenarios (the prompt forces a tool). Open-ended
    // scenarios let each MODEL decide, so tool-call presence can legitimately differ.
    (TOOL_MANDATORY.has(scenario) ? it : it.skip)("every provider calls a tool (tool-mandatory scenario)", async () => {
      for (const p of providers) {
        expect(await derivedUpdateTypes(p, scenario), `${p} did not call a tool`).toContain("tool_call");
      }
    });

    // A tool-using scenario must surface its RESULT on EVERY provider that called a
    // tool. (claude used to drop it — the SDK sends the result in a `user` message
    // the adapter ignored; now fixed. goose always surfaced it.)
    it("surfaces the tool RESULT wherever a tool was called (consistent)", async () => {
      const perProvider = await Promise.all(providers.map((p) => derivedUpdateTypes(p, scenario)));
      for (let i = 0; i < providers.length; i++) {
        if (perProvider[i].includes("tool_call")) {
          expect(perProvider[i], `${providers[i]} called a tool but dropped its result`).toContain("tool_call_update");
        }
      }
    });

    it("produces assistant text on every provider (a run always says something)", async () => {
      for (const p of providers) {
        expect(await derivedUpdateTypes(p, scenario), `${p} produced no assistant text`).toContain("agent_message_chunk");
      }
    });
  });

  // SESSION CONTINUITY across turns — claude resumes an SDK session, goose an ACP
  // continuation. The multi-turn fixture tells the agent a secret in turn 1 and
  // asks for it in turn 2; if a provider lost cross-turn context, the recall fails.
  // Recorded as TWO runs in one conversation (concatenated). Both providers must
  // recall the word — proves session resume works on both.
  const multiTurn = "multi-turn";
  (providersWith(multiTurn).length === 2 ? describe : describe.skip)("scenario: multi-turn (session continuity)", () => {
    it.each(providersWith(multiTurn))("%s recalls the turn-1 secret in its turn-2 reply", (provider) => {
      // The whole conversation's assistant text — turn 2's answer must contain the word.
      expect(assistantText(provider, multiTurn).toUpperCase(), `${provider} lost cross-turn context`).toContain("ZEBRA");
    });
  });
});
