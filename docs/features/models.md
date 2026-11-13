# Models

The model catalog is **provider-first**: model ids are provider-specific namespaces (Bedrock
ids like `us.anthropic.claude-sonnet-4-6` mean nothing to a subscription-backed provider, and
vice versa), so each provider group lists what it offers and marks its own default.

```nix
scooter.agent.availableModels = {
  goose = {
    "us.anthropic.claude-sonnet-4-6" = { default = true; hint = "Fast + cheap."; };
    "us.anthropic.claude-opus-4-8"  = { hint = "Slow + powerful."; };
  };
  byoc."claude-sonnet-4-5" = { default = true; hint = "The user's own subscription."; };
};
```

- A run only ever receives a model **its provider can serve** — the conversation's choice when
  that provider offers it, else that provider's highest-`priority` model. A Bedrock id never
  reaches a bring-your-own container.
- `priority` is an integer, 0 by default; `default = true` is shorthand for `priority = 100`.
  Models tied for the top priority are sampled per conversation, and a conversation stays on its pick.
- The **agent picks its own model** via the `list_models` / `switch_model` tools, steered by
  your `hint`s; the UI and management API can override per conversation.
- Providers: `goose` (Bedrock, or any other goose provider such as `anthropic` and `ollama`),
  `claude-code` (in-cluster subscription SDK), `byoc` (the user's own container), `copilot`
  (goose's `github_copilot` provider; see below).

## GitHub Copilot

A Copilot seat drives the agent through goose's `github_copilot` provider. The credential is
the seat's GitHub token (`gh auth token`, or a fine-grained token) in a Secret, read as
`GITHUB_COPILOT_TOKEN`; goose exchanges it for a Copilot token on its own. Models go under
the `copilot` group, in Copilot's dotted ids:

```nix
scooter.agent = {
  provider = "github_copilot";
  secretEnv.GITHUB_COPILOT_TOKEN = { secret = "agent-copilot-token"; key = "token"; };
  availableModels.copilot = {
    "gpt-5.4"           = { default = true; hint = "Fast enough for most work; streams."; };
    "claude-sonnet-4.6" = { hint = "Small edits and PRs. Answers arrive in one block."; };
  };
};
```

- One token serves every conversation; per-user Copilot is not this provider.
- Claude models do not stream through Copilot (GPT, Gemini and Grok do): a reply arrives as
  one block, so prefer a GPT default.
- GitHub Enterprise: set `GITHUB_COPILOT_HOST` (and `GITHUB_COPILOT_TOKEN_URL`) in
  `scooter.agent.env`.
- goose uses the internal endpoint editors use, presenting itself as one; check your Copilot
  terms before deploying it for a team.

## Context windows

goose looks each model id up in its built-in model table to learn the context window. An id
it does not know yet — typically a Bedrock inference profile newer than the goose build —
falls back to **128,000 tokens**. That makes auto-compaction fire far too early, and the agent,
which is shown its usage against that window, starts declining work it believes will not fit.

Declare the window next to the model:

```nix
scooter.agent.availableModels.goose = {
  "us.anthropic.claude-opus-5-5" = { default = true; contextLimit = 1000000; };
  "us.anthropic.claude-haiku-4-5" = { contextLimit = 200000; };
};
```

Each conversation's goose receives `GOOSE_CONTEXT_LIMIT` for the model it runs on, and a
`switch_model` relaunches goose with the new model's limit. Precedence: a global
`GOOSE_CONTEXT_LIMIT` (via `scooter.agent.env`) > the model's `contextLimit` > goose's own
table.

!!! note "Changing the default model"
    The default comes from the catalog's `default = true` entry, not from `GOOSE_MODEL`:
    with a catalog configured, setting `GOOSE_MODEL` on the Deployment alone changes nothing.

## Extra goose environment

goose gets only an allowlist of the agent-host's environment (provider, model, AWS
credentials, `GOOSE_CONTEXT_LIMIT`, `OLLAMA_HOST`, `GITHUB_COPILOT_TOKEN`, …). To pass more:

```nix
scooter.agent.env = { GOOSE_AUTO_COMPACT_THRESHOLD = "0.7"; GOOSE_MAX_TURNS = "200"; };
# Vars that reach the agent-host some other way (e.g. a patched-in secretKeyRef):
scooter.agent.envPassthrough = [ "GOOSE_TOOLSHIM" ];
```

Both are rendered as `AGENT_ENV_PASSTHROUGH`, a comma-separated list of names the agent-host
forwards on top of the allowlist.
