/**
 * Tier 1 contract test — cost derivation (token usage × price table).
 *
 * Pure functions, fully deterministic. RED against the NOT_IMPLEMENTED design
 * stubs in metrics/pricing.ts.
 */

import { describe, it, expect } from "vitest";

import { parsePriceTable, computeCost, type PriceTable } from "../../src/metrics/pricing.js";

const TABLE: PriceTable = {
  "claude-opus": {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cachedReadPerMillion: 1.5,
    cachedWritePerMillion: 18.75,
  },
  "claude-haiku": { inputPerMillion: 1, outputPerMillion: 5 },
};

describe("pricing — parsePriceTable", () => {
  it("parses a JSON table", () => {
    const t = parsePriceTable(JSON.stringify(TABLE));
    expect(t["claude-opus"].outputPerMillion).toBe(75);
  });

  it("empty/absent table is valid (no models priced)", () => {
    expect(parsePriceTable("{}")).toEqual({});
  });

  it("throws on malformed JSON", () => {
    expect(() => parsePriceTable("{not json")).toThrow();
  });
});

describe("pricing — computeCost", () => {
  it("prices fresh input + output by the per-million rate", () => {
    // 1M input @ $15 + 0.5M output @ $75 = 15 + 37.5 = 52.5
    const c = computeCost(
      "claude-opus",
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      TABLE,
    );
    expect(c.priced).toBe(true);
    expect(c.inputCost).toBeCloseTo(15, 6);
    expect(c.outputCost).toBeCloseTo(37.5, 6);
    expect(c.totalCost).toBeCloseTo(52.5, 6);
  });

  it("prices cached reads/writes at their own rates", () => {
    // 2M cached-read @ $1.5 = 3 ; 100k cached-write @ $18.75 = 1.875
    const c = computeCost(
      "claude-opus",
      { cachedReadTokens: 2_000_000, cachedWriteTokens: 100_000 },
      TABLE,
    );
    expect(c.cachedReadCost).toBeCloseTo(3, 6);
    expect(c.cachedWriteCost).toBeCloseTo(1.875, 6);
    expect(c.totalCost).toBeCloseTo(4.875, 6);
  });

  it("missing cached rates default to 0 (not NaN)", () => {
    // haiku has no cached rates; cached tokens cost nothing, no NaN.
    const c = computeCost("claude-haiku", { inputTokens: 1_000_000, cachedReadTokens: 500_000 }, TABLE);
    expect(c.cachedReadCost).toBe(0);
    expect(c.totalCost).toBeCloseTo(1, 6);
  });

  it("unknown model -> zeroed cost + priced=false (no misleading $0)", () => {
    const c = computeCost("some-unconfigured-model", { inputTokens: 1_000_000 }, TABLE);
    expect(c.priced).toBe(false);
    expect(c.totalCost).toBe(0);
  });

  it("empty usage -> zero cost, priced reflects the model being known", () => {
    const c = computeCost("claude-haiku", {}, TABLE);
    expect(c.totalCost).toBe(0);
    expect(c.priced).toBe(true);
  });
});

describe("pricing — Grok 4.6 (the default Bedrock model)", () => {
  // The rates the example/module ship for `us.xai.grok-4.6` (Bedrock `us.` Geo CRIS
  // tier). Bedrock prompt caching on Grok is IMPLICIT: cache reads bill, cache
  // WRITES do not — so the entry carries no cachedWritePerMillion.
  const GROK: PriceTable = {
    "us.xai.grok-4.6": {
      inputPerMillion: 2.2,
      outputPerMillion: 6.6,
      cachedReadPerMillion: 0.55,
    },
  };

  it("prices input, output and cached reads at the Bedrock rates", () => {
    // 1M in @ $2.20 + 1M out @ $6.60 + 1M cache-read @ $0.55 = $9.35
    const c = computeCost(
      "us.xai.grok-4.6",
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedReadTokens: 1_000_000 },
      GROK,
    );
    expect(c.priced).toBe(true);
    expect(c.inputCost).toBeCloseTo(2.2, 6);
    expect(c.outputCost).toBeCloseTo(6.6, 6);
    expect(c.cachedReadCost).toBeCloseTo(0.55, 6);
    expect(c.totalCost).toBeCloseTo(9.35, 6);
  });

  it("bills no cache-write (Bedrock caching on Grok is implicit)", () => {
    const c = computeCost("us.xai.grok-4.6", { cachedWriteTokens: 1_000_000 }, GROK);
    expect(c.cachedWriteCost).toBe(0);
    expect(c.totalCost).toBe(0);
  });

  it("is cheaper per output token than the Anthropic models it defaults over", () => {
    const usage = { inputTokens: 100_000, outputTokens: 100_000 };
    const grok = computeCost("us.xai.grok-4.6", usage, GROK).totalCost;
    const opus = computeCost("claude-opus", usage, TABLE).totalCost;
    expect(grok).toBeLessThan(opus);
  });
});
