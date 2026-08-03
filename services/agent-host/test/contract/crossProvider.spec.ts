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
 * todo/docs/AGENT_TRANSCRIPT_HARNESS.md.
 */

import { describe, it, expect } from "vitest";

import { scenariosForAllProviders, providersWith, derivedUpdateTypes } from "../support/transcript.js";

const scenarios = scenariosForAllProviders();

describe("cross-provider transcript consistency", () => {
  it("has at least one scenario recorded on both providers", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  describe.each(scenarios)("scenario: %s", (scenario) => {
    const providers = providersWith(scenario);

    it("is recorded for both claude and goose", () => {
      expect(providers.sort()).toEqual(["claude", "goose"]);
    });

    it("emits a tool CALL on all providers or none (consistent)", async () => {
      const has = await Promise.all(providers.map(async (p) => (await derivedUpdateTypes(p, scenario)).includes("tool_call")));
      expect(new Set(has).size, `tool_call presence must match across ${providers.join("/")}`).toBe(1);
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
});
