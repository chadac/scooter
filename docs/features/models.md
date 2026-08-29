# Models

The model catalog is **provider-first**: model ids are provider-specific namespaces (Bedrock
ids like `us.anthropic.claude-sonnet-4-6` mean nothing to a subscription-backed provider, and
vice versa), so each provider group lists what it offers and marks its own default.

```nix
agentSandbox.agent.availableModels = {
  goose = {
    "us.xai.grok-4.6"               = { default = true; hint = "Cheapest + 500K context."; };
    "us.anthropic.claude-sonnet-4-6" = { hint = "Mid-cost; prompt caching."; };
    "us.anthropic.claude-opus-4-8"  = { hint = "Slow + powerful."; };
  };
  byoc."claude-sonnet-4-5" = { default = true; hint = "The user's own subscription."; };
};
```

- A run only ever receives a model **its provider can serve** — the conversation's choice when
  that provider offers it, else that provider's default. A Bedrock id never reaches a
  bring-your-own container.
- The **agent picks its own model** via the `list_models` / `switch_model` tools, steered by
  your `hint`s; the UI and management API can override per conversation.
- Providers: `goose` (Bedrock), `claude-code` (in-cluster subscription SDK), `byoc` (the
  user's own container).

## Cost vs. performance

Bedrock list prices, USD per 1M tokens (`us.` Geo cross-Region tier). These feed
`observability.otel.pricing`, so keeping them accurate keeps the cost metric honest.

| Model | Input | Output | Cache read | Context |
| --- | --- | --- | --- | --- |
| `us.xai.grok-4.6` | $2.20 | $6.60 | $0.55 | 500K |
| `us.anthropic.claude-sonnet-4-6` | $3.00 | $15.00 | $0.30 | 200K |
| `us.anthropic.claude-opus-4-8` | $15.00 | $75.00 | $1.50 | 200K |

Grok 4.6 is the **default**: it is the cheapest of the three on both input and output —
roughly **2.3x cheaper on output than Sonnet** and **11x cheaper than Opus** — and its 500K
context swallows large repo reads that would force compaction on a 200K model. Agent runs are
output-heavy (tool calls, diffs, reasoning), so the output rate dominates the bill.

Two caveats worth pricing in before treating it as strictly cheapest:

- **Cache reads are ~1.8x Sonnet's.** Bedrock prompt caching on Grok is *implicit* (no
  cache-write charge, but no explicit control either), while goose only enables explicit
  Anthropic caching for `anthropic.claude` models. A long conversation that re-reads a big
  stable prefix every turn can favour Sonnet despite its higher headline rates.
- **Reasoning tokens bill as output.** Grok reasons by default; effort is configurable
  (`low`/`medium`/`high`/`xhigh`, default `low`). Higher effort raises real cost per turn
  above what the headline output rate suggests.

Escalate to Opus only where its quality actually changes the outcome — architecture, novel
implementations, hard debugging — since it costs over 11x Grok per output token.
