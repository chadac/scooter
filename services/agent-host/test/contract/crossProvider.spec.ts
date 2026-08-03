/**
 * Tier 1 — CROSS-PROVIDER consistency, driven by REAL recorded transcripts.
 *
 * For each scenario we recorded on BOTH claude and goose, assert the bridge's
 * emitted AG-UI (the provider-normalized layer the UI renders from) is CONSISTENT
 * across providers. Where it isn't, that's a real divergence to fix — the harness
 * exists to catch exactly this (the check_subagent back-pressure bug was a
 * provider divergence hidden by fakes). See todo/docs/AGENT_TRANSCRIPT_HARNESS.md.
 *
 * These assert on the recorded `agui-out` directly (what the server actually
 * produced from the real agent), so they can't pass on a fiction.
 */

import { describe, it, expect } from "vitest";

import { providersWith, loadFixture, aguiOutEntries } from "../support/transcript.js";

/** The AG-UI event types the bridge emitted for a recorded scenario. */
function aguiTypes(provider: "claude" | "goose", scenario: string): string[] {
  return (aguiOutEntries(loadFixture(provider, scenario)) as Array<{ type?: string }>).map((e) => e.type ?? "?");
}

describe("cross-provider: shell-tool-and-result", () => {
  const scenario = "shell-tool-and-result";
  const providers = providersWith(scenario);

  it("was recorded for both providers (claude + goose)", () => {
    expect(providers.sort()).toEqual(["claude", "goose"]);
  });

  it.each(providers)("%s emits a tool CALL (TOOL_CALL_START) for the shell tool", (provider) => {
    expect(aguiTypes(provider, scenario)).toContain("TOOL_CALL_START");
  });

  // DIVERGENCE the harness caught: goose surfaces the tool RESULT
  // (tool_call_update -> TOOL_CALL_RESULT); claude sends tool_result in a `user`
  // message that sdkAdapter DROPS (no `case "user"`), so claude emits NO
  // TOOL_CALL_RESULT — its tool output never renders in the UI. This test asserts
  // CONSISTENCY: EVERY provider that made a tool call must surface its result.
  // `it.fails` = expected to fail TODAY (claude drops it); it starts passing once
  // the adapter is fixed → vitest flags it → remove `.fails`.
  it.fails("BOTH providers surface the tool RESULT (TOOL_CALL_RESULT) — claude currently drops it", () => {
    for (const provider of providers) {
      expect(aguiTypes(provider, scenario), `${provider} should surface TOOL_CALL_RESULT`).toContain("TOOL_CALL_RESULT");
    }
  });

  it("goose surfaces the tool result today (baseline — proves the assertion is meaningful)", () => {
    expect(aguiTypes("goose", scenario)).toContain("TOOL_CALL_RESULT");
  });
});
