/**
 * Cost derivation: token usage × a per-model price table.
 *
 * The price table is deployer-supplied config (a JSON ConfigMap; see
 * modules/platform.nix `observability.pricing`). Prices are USD per 1,000,000
 * tokens, split by token kind so cached reads/writes can be priced differently
 * from fresh input/output (providers charge these at different rates).
 *
 * DESIGN STAGE: signatures + types only. No implementation.
 */

/** Per-model prices, USD per 1e6 tokens. Missing fields default to 0. */
export interface ModelPrice {
  /** USD per 1M fresh input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per 1M output (completion) tokens. */
  outputPerMillion: number;
  /** USD per 1M cached-read input tokens (cheaper than fresh input). Optional. */
  cachedReadPerMillion?: number;
  /** USD per 1M cache-write tokens. Optional. */
  cachedWritePerMillion?: number;
}

/** The full price table: model id -> prices. The model id matches GOOSE_MODEL /
 *  the conversation's resolved model (e.g. "us.anthropic.claude-opus-4-7"). */
export type PriceTable = Record<string, ModelPrice>;

/** A single run's token usage (from goose's session DB). All counts are deltas
 *  attributable to ONE run unless noted. Fields are optional so a partial/older
 *  goose schema still yields a best-effort cost. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  /** thought/reasoning tokens, if the provider reports them separately. */
  thoughtTokens?: number;
  /** total, if the source gives a total but not the split. */
  totalTokens?: number;
}

/** The derived cost breakdown for a run, USD. */
export interface CostBreakdown {
  model: string;
  inputCost: number;
  outputCost: number;
  cachedReadCost: number;
  cachedWriteCost: number;
  totalCost: number;
  /** False when the model wasn't in the price table (cost is 0, surfaced so a
   *  caller can warn / skip the cost metric rather than report a misleading 0). */
  priced: boolean;
}

/**
 * Parse a price table from the raw JSON the ConfigMap provides. Throws on
 * malformed JSON; tolerates extra/missing per-model fields (missing -> 0).
 * An empty/absent table is valid (yields a table that prices everything at 0,
 * `priced: false`).
 */
export function parsePriceTable(json: string): PriceTable {
  const raw = JSON.parse(json) as Record<string, Partial<ModelPrice>>;
  const out: PriceTable = {};
  for (const [model, p] of Object.entries(raw ?? {})) {
    out[model] = {
      inputPerMillion: Number(p.inputPerMillion ?? 0),
      outputPerMillion: Number(p.outputPerMillion ?? 0),
      cachedReadPerMillion: p.cachedReadPerMillion != null ? Number(p.cachedReadPerMillion) : undefined,
      cachedWritePerMillion: p.cachedWritePerMillion != null ? Number(p.cachedWritePerMillion) : undefined,
    };
  }
  return out;
}

/**
 * Compute the USD cost of a run from its token usage and the price table.
 * If `model` is absent from the table, returns a zeroed breakdown with
 * `priced: false` (so cost isn't silently reported as a real $0).
 */
export function computeCost(model: string, usage: TokenUsage, prices: PriceTable): CostBreakdown {
  const price = prices[model];
  const perM = (tokens: number | undefined, rate: number | undefined): number =>
    ((tokens ?? 0) * (rate ?? 0)) / 1_000_000;

  if (!price) {
    return {
      model,
      inputCost: 0,
      outputCost: 0,
      cachedReadCost: 0,
      cachedWriteCost: 0,
      totalCost: 0,
      priced: false,
    };
  }

  const inputCost = perM(usage.inputTokens, price.inputPerMillion);
  const outputCost = perM(usage.outputTokens, price.outputPerMillion);
  const cachedReadCost = perM(usage.cachedReadTokens, price.cachedReadPerMillion);
  const cachedWriteCost = perM(usage.cachedWriteTokens, price.cachedWritePerMillion);
  return {
    model,
    inputCost,
    outputCost,
    cachedReadCost,
    cachedWriteCost,
    totalCost: inputCost + outputCost + cachedReadCost + cachedWriteCost,
    priced: true,
  };
}
