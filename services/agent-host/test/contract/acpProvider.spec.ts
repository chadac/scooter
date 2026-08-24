/**
 * Tier 1 contract — the ACP provider resolver (pickAcpProvider).
 *
 * Locks the per-run selection contract: highest-priority ELIGIBLE provider wins, with an
 * always-eligible floor guaranteeing a pick. This is the seam the human-trigger guardrail
 * (Increment 2) plugs into — a `remote-personalized` provider whose eligible() keys on
 * owner + source. See todo/done/BYO_CLAUDE_REMOTE_AGENT.md.
 */

import { describe, it, expect } from "vitest";

import { pickAcpProvider, type AcpProvider, type RunContext } from "../../src/acp/provider.js";

/** A stub provider — createClient is never called by the resolver (pure selection). */
const provider = (
  id: string,
  priority: number,
  eligible: (ctx: RunContext) => boolean,
  kind: "goose" | "claude" = "goose",
): AcpProvider => ({
  id,
  kind,
  priority,
  eligible,
  createClient: () => {
    throw new Error("createClient must not be called by the resolver");
  },
});

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  conversationId: "c1" as RunContext["conversationId"],
  ...over,
});

const floor = provider("bedrock-goose", 0, () => true);

describe("pickAcpProvider", () => {
  it("picks the highest-priority eligible provider", async () => {
    const remote = provider("remote-personalized", 10, () => true);
    expect((await pickAcpProvider([floor, remote], ctx()))?.id).toBe("remote-personalized");
  });

  it("falls to the always-eligible floor when the higher-priority provider is INELIGIBLE", async () => {
    // The guardrail shape: remote is only eligible for human sources; a scheduled run drops to floor.
    const remote = provider("remote-personalized", 10, (c) => c.source !== "scheduler");
    expect((await pickAcpProvider([floor, remote], ctx({ source: "ui" })))?.id).toBe("remote-personalized");
    expect((await pickAcpProvider([floor, remote], ctx({ source: "scheduler" })))?.id).toBe("bedrock-goose");
  });

  it("returns undefined when NO provider is eligible (misconfigured registry fails loud)", async () => {
    const none = provider("x", 5, () => false);
    expect(await pickAcpProvider([none], ctx())).toBeUndefined();
  });

  it("is deterministic — tie-break by id at equal priority", async () => {
    const a = provider("aaa", 5, () => true);
    const b = provider("bbb", 5, () => true);
    expect((await pickAcpProvider([b, a], ctx()))?.id).toBe("aaa");
    expect((await pickAcpProvider([a, b], ctx()))?.id).toBe("aaa");
  });

  it("selection is PER-CONTEXT — the same registry picks differently as source changes", async () => {
    const remote = provider("remote-personalized", 10, (c) => c.source === "ui" || c.source === "slack");
    const reg = [floor, remote];
    expect((await pickAcpProvider(reg, ctx({ source: "slack" })))?.id).toBe("remote-personalized");
    expect((await pickAcpProvider(reg, ctx({ source: "scheduler" })))?.id).toBe("bedrock-goose");
    expect((await pickAcpProvider(reg, ctx({ source: undefined })))?.id).toBe("bedrock-goose");
  });
});
