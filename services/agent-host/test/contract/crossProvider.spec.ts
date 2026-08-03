/**
 * Tier 1 — CROSS-PROVIDER consistency, driven by REAL recorded transcripts.
 *
 * For each scenario recorded on BOTH claude and goose, assert the provider-
 * normalized SessionUpdates are CONSISTENT across providers. Where they aren't,
 * that's a real divergence to fix — the harness exists to catch exactly this (the
 * check_subagent back-pressure bug was a provider divergence hidden by fakes).
 *
 * Crucially this re-derives the updates from the recorded INPUT (claude sdk-in
 * through the LIVE adapter; goose acp-in are already normalized) — so it reflects
 * TODAY's code, not the frozen agui-out captured at record time. A fix flips it.
 * See todo/docs/AGENT_TRANSCRIPT_HARNESS.md.
 */

import { describe, it, expect } from "vitest";

import { providersWith, derivedUpdateTypes } from "../support/transcript.js";

describe("cross-provider: shell-tool-and-result", () => {
  const scenario = "shell-tool-and-result";
  const providers = providersWith(scenario);

  it("was recorded for both providers (claude + goose)", () => {
    expect(providers.sort()).toEqual(["claude", "goose"]);
  });

  it.each(providers)("%s emits a tool CALL (tool_call) for the shell tool", async (provider) => {
    const types = await derivedUpdateTypes(provider, scenario);
    expect(types).toContain("tool_call");
  });

  // The divergence the harness caught + we FIXED: claude sent tool_result in a
  // `user` message the adapter dropped (no `case "user"`), so no tool_call_update
  // was emitted → claude tool output never rendered. goose always surfaced it. Now
  // BOTH providers must surface the tool RESULT (a tool_call_update). Re-derived
  // from the recorded input through the current adapter, so this asserts the FIX.
  it("BOTH providers surface the tool RESULT (tool_call_update) — consistency", async () => {
    for (const provider of providers) {
      const types = await derivedUpdateTypes(provider, scenario);
      expect(types, `${provider} should surface tool_call_update`).toContain("tool_call_update");
    }
  });
});
