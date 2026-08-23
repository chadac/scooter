# Scooter

[![CI](https://github.com/chadac/scooter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/chadac/scooter/actions/workflows/ci.yml)
[![Publish images](https://github.com/chadac/scooter/actions/workflows/publish-images.yml/badge.svg?branch=main)](https://github.com/chadac/scooter/actions/workflows/publish-images.yml)
[![Docs](https://github.com/chadac/scooter/actions/workflows/docs.yml/badge.svg?branch=main)](https://chadac.github.io/scooter/)
[![Container images](https://img.shields.io/badge/ghcr.io-chadac%2Fscooter-blue?logo=docker&logoColor=white)](https://github.com/chadac?tab=packages&repo_name=scooter)

A Nix-powered agent platform layered over the Kubernetes
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller.

agent-sandbox provides the execution **body** — pods, warm pools, suspend/resume.
Scooter adds the **brain** (an off-the-shelf ACP agent — [Goose](https://github.com/block/goose) — run
*outside* the sandbox) and a **conversation UI** (AG-UI + [assistant-ui](https://github.com/assistant-ui/assistant-ui)).
The agent drives the sandbox through the agent-sandbox API and the Kubernetes exec
API; nothing runs as an in-pod agent.

> **Status:** implemented and running in production-shaped deployments. Multi-replica
> agent-hosts with controller-assigned conversations, suspend/resume with history
> restore, bring-your-own-Claude (device-key auth, concurrent conversations), a
> provider-aware model catalog, webhooks/scheduler/broker integrations, and a working
> UI. Enable BYOC with one option: `agentSandbox.byoc.enable = true`.
>
> **Docs:** <https://chadac.github.io/scooter/> — including the full
> [configuration reference](https://chadac.github.io/scooter/reference/options/),
> generated from the kubenix modules.

## Idea

- **Brain:** an off-the-shelf **ACP** agent (Goose, from nixpkgs), run **outside**
  the sandbox in an **agent-host**. No agent loop is hand-written.
- **UI seam:** **AG-UI** over SSE, consumed natively by **assistant-ui**.
- **Exec:** the agent's actions are serviced by the **Kubernetes exec API**
  (`pods/exec`) against the conversation's pod — `run`/`spawn` exec directly, file
  ops go through `cat`/`tee`. There is **no in-pod HTTP server**.
- **Nix:** a generic NixOS sandbox image (overlay store, lazy tool shims, skills).
- **kubenix:** modules that render the per-conversation `Sandbox` + the supporting
  platform resources (agent-host, broker, webhooks, scheduler).

```
browser  (assistant-ui / AG-UI over SSE)
   │
   ▼
agent-host  ── spawns `goose acp` per conversation ── ACP⇄AG-UI bridge
   │  ├ SessionManager · ConversationStore (conversation-state PVC = brain)
   │  ├ MCP tools: slack/github/gitlab/jira · web search/fetch · background jobs ·
   │  │            model switch · sandbox resize · scheduled tasks
   │  └ web-service reverse proxy  →  /c/<id>/<service>/…
   │
   ├─ Kubernetes exec API (pods/exec) ──► Sandbox pod (body, NixOS · systemd PID 1)
   │                                        ├ workspace PVC (the agent's files)
   │                                        ├ web services: marimo · VS Code · xterm
   │                                        └ scooter-* CLIs (broker, aws, service)
   │
   └─ broker (SA-token auth) ──► GitHub · GitLab · Jira · Slack · AWS · Datadog

webhooks   spawn a conversation from a GitHub/GitLab/Jira/Slack thread → agent-host
scheduler  fire a cron task → a fresh conversation per run → agent-host
agent-sandbox controller:  warm pools · suspend (drop Pod, keep PVCs) / resume
```

## Key decisions

- **The agent runs outside the pod.** agent-sandbox is execution-as-a-service; the
  agent-host drives the pod over the exec API. If Goose or the agent-host ends up
  *inside* the sandbox image, that's the inverted (wrong) model.
- **One cold `Sandbox` per conversation** (not a warm-pool claim): required for the
  per-conversation ServiceAccount (the pod's broker identity) and its persistent
  PVCs. Warm pools are only for generic capacity.
- **Suspend, don't delete.** The `Sandbox` object is the durable conversation
  handle. Suspend drops the Pod and keeps the PVCs; resume revives the same SA +
  PVCs. Two PVCs persist: the **workspace** (the agent's files) and the
  **conversation-state** (the brain).
- **Credentials flow through the broker.** The pod authenticates with its projected
  ServiceAccount token; the agent-host holds no third-party secrets. The typed
  provider tools (and the raw `$BROKER_URL/<provider>/…` proxy) go through it.
- **Provider tools gate on attachment.** `slack_respond`, `github_comment`, etc. are
  registered only when that resource is actually linked to the conversation — so the
  agent never replies into a channel it has no context for. Errors from upstream are
  surfaced verbatim (never hidden behind a generic failure).

## Layout

| Path | What |
|------|------|
| `flake.nix` | Nix entry: sandbox image, agent-host, ui, broker, webhooks, scheduler, agent (goose), platform manifests |
| `services/agent-host/` | TypeScript: ACP⇄AG-UI bridge, session manager, K8s-exec backend, web-service proxy, MCP agent tools, auth |
| `services/broker/` | Python/FastAPI credential broker + provider modules (GitHub, GitLab, Jira, Slack, AWS/IRSA, Datadog) |
| `services/webhooks/` | Python/FastAPI: spawn conversations from GitHub/GitLab/Jira/Slack threads |
| `services/scheduler/` | Python/FastAPI: fire cron-scheduled tasks, one fresh conversation per run |
| `services/claude-sdk-provider/` | Claude Agent SDK provider (an alternative brain to goose) |
| `pkgs/sandbox-os/` | The NixOS systemd-PID-1 sandbox image (exec via the K8s API) |
| `pkgs/broker-tools/` | Broker CLIs prebuilt into the sandbox: `agent-broker`, `git-credential-broker`, `scooter-aws*` |
| `modules/` | kubenix: per-conversation cold `Sandbox` (SA + 2 PVCs), agent-host, broker, webhooks, scheduler, warm pool, web-services |
| `ui/` | assistant-ui frontend + reusable AG-UI client library |
| `skills/` | Markdown agent skills (`scooter-intro`, `scooter-env`, `agent-tools`, `scooter-web-services`, `scooter-aws`, …) |
| `examples/` | Reference kubenix config + manifest checks |
| `deploy/` | A separate deployment flake (config + `deploy.sh`) for standing the platform up on a real cluster |
| `test/` | Tier 2 cluster + Tier 3 e2e fixtures/fakes |
| `nixos-tests/` | NixOS VM tests for the dev-environment sandbox image |
| `docs/` | Subsystem docs (the full `DESIGN.md`/`TESTING.md` are kept locally, outside the repo) |

## Subsystems

- **Web services** — declarative in-pod services (marimo, browser VS Code via
  code-server, an xterm terminal via ttyd) that the platform reverse-proxies at
  `https://<host>/c/<id>/<service>/`. Discovered from an in-pod manifest; started
  and stopped at runtime with the `scooter-service` CLI (or from the UI).
- **Broker + provider tools** — a credential vault and transparent proxy. Typed MCP
  tools (`slack_respond`, `slack_react`, `github_comment`, `gitlab_comment`,
  `jira_comment`, `web_search`, `web_fetch`) wrap it; anything else uses the raw
  `$BROKER_URL/<provider>/<api-path>` proxy with a Bearer token from
  `$BROKER_TOKEN_PATH`.
- **Webhooks** — turn an inbound GitHub/GitLab/Jira/Slack event into a conversation.
- **Scheduler** — cron-fire tasks, each spawning a fresh conversation; the agent
  manages its own schedules through MCP tools.
- **Skills** — markdown guidance injected into the agent (Nix usage, the broker,
  web services, AWS, links, formatting). Exposed as `lib.scooterSkills` for external
  deployers.

## Building & testing

[`just`](https://github.com/casey/just) is the task runner. **The tests are the
spec** — run them to confirm changes rather than assuming.

```bash
just test-quick     # Tier 1 contract tests — fast, no cluster. Run constantly.
just test           # FULL suite: Tier 1 + Tier 2 (cluster) + Tier 3 (E2E).
just ci             # What CI runs: flake check + typecheck + Tier 1.
```

Per tier:

```bash
just test-unit       # Tier 1  (no cluster, no network)
just test-cluster    # Tier 2  (real k8s; auto-starts a local k3s cluster)
just test-e2e        # Tier 3  (Playwright through the UI; fake ACP agent)
just test-e2e-real   # Tier 3  (one scenario with REAL goose; needs a model key)
```

Build:

```bash
just build           # agent-host + UI + sandbox image
just build-image     # just the sandbox-os image
just image-sizes     # measure shipped image sizes (JSON)
```

## Deploying

The [`deploy/`](deploy/) directory is a self-contained flake (config + `deploy.sh`)
that builds the images, pushes them to a registry, re-locks against your working
tree, and applies the rendered kubenix manifests to a cluster. See its own README.

## Provenance

Distilled from the `openhands-nix` sibling project (skills, broker, webhooks, image
patterns), re-targeted from OpenHands' bundled runtime onto agent-sandbox + ACP +
AG-UI.

## License

Scooter is [MIT-licensed](./LICENSE). Its dependencies are permissive
(MIT / BSD / Apache-2.0 / MPL-2.0) with **one exception**: the Anthropic Claude
Agent SDK and the `claude-code` CLI are proprietary and used under Anthropic's
terms — they are not covered by the MIT license. See [NOTICE.md](./NOTICE.md) for
the full third-party inventory and how to run a fully open-source (Goose-only)
deployment.
