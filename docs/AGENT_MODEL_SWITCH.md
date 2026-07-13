# Agent model switching — design spec

**Status:** Research/Design (PoC stages 1–2). Tests + impl follow.

## Problem

Bedrock Opus 4.7/4.8 average ~22s/inference (8–34s variance) vs Sonnet 4.6 ~2s —
so an Opus-by-default agent spends ~97% of a conversation on inference (a 10-line
PR took 36 min). There's no way for the agent to run simple work on a fast model.

## Chosen fix

Give the agent two **MCP tools** so it can pick its own model, and let deployments
guide the choice with per-model **hints**. Customers write an intro skill ("use the
fast model for simple edits; escalate to the powerful one for architecture/complex
debugging"); the agent lists models and switches opportunistically.

| Decision | Choice |
|----------|--------|
| Tools | **`list_models`** + **`switch_model(model)`** on the existing `scooter-env` MCP server |
| Switch timing | **Immediate** — cancel the running turn, rebuild goose with the new model, **auto re-nudge** ("continue where you left off") so it resumes on the new model |
| Config | **Attrset** `agent.availableModels.<id> = { enable; hint; default; }` — `default` marks the default model, `enable` gates, `hint` is deployment guidance (surfaced by `list_models`) |
| Encoding | JSON env var to the agent-host (so hints/flags survive; replaces the comma-sep `AGENT_AVAILABLE_MODELS`) |

## The mid-turn subtlety (the risky part)

`switch_model` is called **while goose is running** (it's a tool call mid-turn).
Today's `manager.applyModelSwitch` (`manager.ts:454`) tears down the bridge
immediately and relies on the *next* prompt to rebuild — if called mid-turn that
would **kill the very run that called the tool**. So an immediate switch needs a
NEW manager primitive that, at the tool call:

1. records the new model on the entry (persisted, like applyModelSwitch),
2. **cancels** the current run (bridge cancel — the run that made the tool call
   ends cleanly, RUN_FINISHED),
3. **rebuilds** the bridge with the new `GOOSE_MODEL`,
4. **re-nudges** with the synthetic "continue where you left off" prompt (the exact
   `resumeInterrupted` path, `manager.ts:717`), so the agent resumes its own work
   on the new model.

This reuses machinery that already exists (bridge cancel + revive + synthetic
nudge), so it's not new risk surface — but it MUST avoid the model-switch-midconvo
race (a quarantined e2e where a server-side goose rebuild raced the prompt). The
re-nudge is sent AFTER the rebuild completes, single-threaded per conversation.

The tool's own response to goose is essentially the last thing the old run emits;
the continuation is a fresh run on the new model. The tool text tells the agent so
("Switched to <model>. Continuing on the new model.").

## Components

### 1. Config: `agent.availableModels` becomes an attrset (`modules/platform.nix`)

```nix
agent.availableModels = {
  "us.anthropic.claude-sonnet-4-6" = {
    enable = true;
    default = true;
    hint = "Fast + cheap. Use for simple edits, config/CI fixes, straightforward PRs.";
  };
  "us.anthropic.claude-opus-4-8" = {
    enable = true;
    hint = "Slow + powerful. Escalate for architecture, novel implementations, hard debugging.";
  };
};
```

- Each entry: `enable` (default true), `hint` (default ""), `default` (default
  false — exactly one should be true; it's the fallback model).
- **Backward-compat:** accept the old `listOf str` too (coerce each string to
  `{ enable = true; }`), and keep `agent.model` working as the default when no
  entry sets `default = true`.
- Rendered to the agent-host as a **JSON** env var (e.g. `AGENT_MODELS_JSON`), an
  array of `{ id, hint, default }` for enabled models. The legacy
  `AGENT_AVAILABLE_MODELS` (comma-sep) can stay as a derived value for anything
  still reading it, or be dropped.

### 2. agent-host config (`index.ts`)

- Parse `AGENT_MODELS_JSON` into `{ id, hint, default }[]`; derive `model`
  (the default) + `availableModels` (ids) so `resolveModel` (`index.ts:184`) and
  `GET /models` keep working. `GET /models` gains the hints.

### 3. Manager: an immediate-switch primitive (`manager.ts`)

New method, e.g. `switchModelNow(id, model): Promise<void>`:
- validates via `resolveModel` (rejects unknown/disabled — the tool surfaces the
  valid list),
- no-op if already the current model,
- otherwise: persist model → cancel the running bridge → rebuild → send the
  synthetic continue-nudge (factor the nudge out of `resumeInterrupted` so both
  share it).
- Serialized per conversation (the manager already single-threads per entry).

### 4. MCP tools (`mcpServer.ts` + a new `modelTools.ts`)

Mirror `agentTools`/`modify_environment`:
- `list_models` → `{ models: [{ id, hint, current: bool, default: bool }] }` as
  text. Deps: a models getter + `sessions.get(convId)?.model` for `current`.
- `switch_model(model: string)` → calls `manager.switchModelNow(convId, model)`;
  on an unknown model returns an error listing the valid ids. Deps: the manager +
  models getter.
- Registered in `buildServer` behind a new `models` dep on `createMcpEndpoint`.
- Pure handlers (`handleListModels`, `handleSwitchModel`) for unit testing.

### 5. Skill (`skills/scooter-models.md`)

Teach the pattern: check `list_models`, pick the cheap/fast model for simple work,
escalate to the powerful one for complex planning/research/debugging, and that a
switch continues the current task on the new model. Customers tune the guidance
(the hints come from their config).

## Areas of uncertainty (resolve into Design/impl)

1. **The mid-turn cancel/rebuild/re-nudge race** — highest risk. Must not
   reintroduce the model-switch-midconvo race (quarantined e2e). The re-nudge is
   strictly after rebuild; per-conversation serialization guards it.
2. **The tool call's own run ends when we cancel it** — goose sees the tool result,
   then RUN_FINISHED; the continuation is a new run. Confirm goose handles "tool
   returned, then the run ends, then a new run continues" cleanly (it's the
   restart-resume shape, which works).
3. **Config migration** — the attrset change is the visible breaking bit; the
   backward-compat coercion + a check-manifests render must keep existing deploys
   working (aeonai sets `agent.model` + a flat `availableModels`).
4. **Default-model derivation** — exactly one `default = true`; assert it, and fall
   back to `agent.model` when none is set.
5. **Cost/latency loop** — out of scope here: the report's server-side complexity
   routing (webhooks estimates complexity) is a separate, larger idea. This PR is
   agent-initiated only.

## Out of scope (this PR)

- Server-side complexity-based routing (webhooks picks a model from the message).
- Opus-plan-then-Sonnet-execute automation (the agent can do this itself with these
  tools + a skill).
- Bedrock latency/provisioned-throughput investigation (infra, not this repo).

## Test seams

- **Tier 1 (contract):**
  - `modelTools.spec.ts`: `handleListModels` returns enabled models with
    current/default flags + hints; `handleSwitchModel` calls `switchModelNow` for a
    valid model, and errors with the valid list for an unknown/disabled one (never
    switches blind).
  - `manager` `switchModelNow`: persists the model, cancels the live bridge,
    rebuilds, and sends the synthetic nudge — against fakes (assert the sequence +
    that it's a no-op for the same model). Guard: it does NOT tear down without
    rebuilding (the mid-turn-kill regression).
  - config parse: `AGENT_MODELS_JSON` → default + availableModels + hints;
    backward-compat from the flat form.
- **check-manifests / render:** the attrset renders the JSON env; backward-compat
  from `listOf str` + `agent.model`.
- **Tier 3 (e2e):** the agent calls `switch_model` mid-conversation and the next
  turn runs on the new model (extends the model-selection e2e; watch the
  quarantined race).
