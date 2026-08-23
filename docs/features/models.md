# Models

The model catalog is **provider-first**: model ids are provider-specific namespaces (Bedrock
ids like `us.anthropic.claude-sonnet-4-6` mean nothing to a subscription-backed provider, and
vice versa), so each provider group lists what it offers and marks its own default.

```nix
agentSandbox.agent.availableModels = {
  goose = {
    "us.anthropic.claude-sonnet-4-6" = { default = true; hint = "Fast + cheap."; };
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
