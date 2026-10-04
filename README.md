# Scooter

[![CI](https://github.com/chadac/scooter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/chadac/scooter/actions/workflows/ci.yml)
[![Publish images](https://github.com/chadac/scooter/actions/workflows/publish-images.yml/badge.svg?branch=main)](https://github.com/chadac/scooter/actions/workflows/publish-images.yml)
[![Docs](https://github.com/chadac/scooter/actions/workflows/docs.yml/badge.svg?branch=main)](https://chadac.github.io/scooter/)
[![Container images](https://img.shields.io/badge/ghcr.io-chadac%2Fscooter-blue?logo=docker&logoColor=white)](https://github.com/chadac?tab=packages&repo_name=scooter)

**NixOS for your agents.**

Scooter runs a fleet of coding agents on Kubernetes, and the entire thing — the
machines agents work on, the services they can reach, the credentials they can
borrow, the models they may use, the tools they expose to themselves — is one
typed Nix configuration. You change a value, you rebuild, you get that platform.
The same bargain NixOS makes for a machine, made for an agent fleet.

That is not a loose analogy. An agent's sandbox *is* a NixOS machine with systemd
as PID 1, and when an agent decides it needs a new tool or a long-running service,
it writes a NixOS module and runs a switch — registering a numbered generation,
with auto-rollback if the new config comes up broken.

> **Status:** implemented and running in production-shaped deployments. Multi-replica
> agent-hosts with controller-assigned conversations, suspend/resume with history
> restore, bring-your-own-Claude (device-key auth, concurrent conversations), a
> provider-aware model catalog, declarative in-pod MCP servers and web services,
> webhooks/scheduler/broker integrations, and a working UI.
>
> **Docs:** <https://chadac.github.io/scooter/> — including the full
> [configuration reference](https://chadac.github.io/scooter/reference/options/),
> generated from the kubenix modules.

## Why "NixOS for your agents"

| NixOS | Scooter |
|---|---|
| `configuration.nix` — one typed option tree describes a machine | one typed `agentSandbox.*` tree describes the whole platform: sandboxes, UI, broker, webhooks, scheduler, model catalog, ingress |
| `services.<name>.enable = true` | `mcpServers.<name>` and `webServices.<name>` — declare a server once; you get the systemd unit *and* the manifest that makes it discoverable to the agent |
| `nixos-rebuild switch` | `scooter-rebuild switch` — run **by the agent, inside its own sandbox**, applied live with no restart |
| numbered generations, `--rollback` | the same ladder, literally: each switch registers a generation; a switch that leaves failed units rolls back and re-switches |
| modules and overlays | `contribs.<name>` — an integration is a self-contained directory with entry points, never a patch to a service's core |
| channels / flake inputs | a shared module registry an agent attaches from (`scooter-rebuild module add <id>`), composed at converge time |
| `man configuration.nix`, options search | an [option reference](https://chadac.github.io/scooter/reference/options/) generated from the modules, so it cannot drift from the code |

Three module layers compose into every switch, mirroring how a NixOS system,
its channels, and a user's own config compose: **deployment defaults** (served by
the broker), **attached registry modules** (shared, versioned), and the agent's
**own locally authored modules** (durable on its workspace volume).

## What it provides

**Sandboxes that are machines, not container images.** One sandbox per
conversation: NixOS, systemd PID 1, a persistent workspace. Agents install what
they need at runtime (`nix profile install`, `nix run`) rather than waiting on
someone to rebuild a dev image. An overlay `/nix/store` backed by a warm PVC pool
means common tools are frequently already built, and heavier tools ship as lazy
stubs that cost nothing until first run.

**Conversations are first-class cluster objects.** A `Conversation` CRD — so
`kubectl get conv` is a real answer to "what is my fleet doing". A controller
assigns conversations across agent-host replicas, suspends idle ones (the Pod
goes away, the volumes stay), and resumes them with transcript, workspace, and
installed tools intact.

**Credentialed access to real services, without handing agents credentials.** A
broker holds the secrets; the sandbox authenticates with its projected
ServiceAccount token and reaches GitHub, GitLab, Jira, Slack, AWS, Datadog,
Grafana, Airtable through a transparent proxy. The agent never sees a token.
Access can be dynamic and approval-gated (AWS STS per account), and every
provider is a contrib module you enable in Nix.

**Identity and RBAC are Kubernetes-native, not bolted on.** Each conversation
gets its own ServiceAccount — that *is* the agent's identity to the broker, and
what it can reach is scoped by ordinary Kubernetes RBAC. Typed provider tools
(`github_comment`, `slack_respond`, …) register only when that resource is
actually linked to the conversation, so an agent cannot reply into a channel it
has no context for.

**The agent's own capabilities are configuration.** The model catalog, the sandbox
size menu, injected skills, available MCP servers — all options, and the option
tree is the enforcement boundary rather than a suggestion. `sandboxSizes` is the
only set of shapes the UI offers *and* the only set the agent's resize tool
accepts, so a deployment cannot be asked for a pod its nodes can't schedule.

**Bring your own brain.** The agent is an off-the-shelf **ACP** implementation
run *outside* the sandbox — [Goose](https://github.com/block/goose) from nixpkgs
by default, with a Claude Agent SDK provider as an alternative, plus
bring-your-own-Claude so a user can serve their own conversations from their own
subscription. No agent loop is hand-written here.

## The configuration

The whole platform is one kubenix module. Abridged, with the flavour of it:

```nix
agentSandbox = {
  namespace = "agent-sandbox";

  agent.availableModels.goose."us.anthropic.claude-sonnet-4-6" = {
    default = true;
    hint = "Fast + cheap. Use for simple edits, config/CI fixes, straightforward PRs.";
  };

  # The only sizes the UI offers and the only ones the agent may ask for.
  sandboxSizes = {
    medium = { cpu = "2"; memory = "4Gi"; default = true; hint = "Builds and test suites."; };
    gpu-small = { cpu = "4"; memory = "16Gi"; gpu = 1; hint = "Local model inference."; };
  };

  broker.enable = true;                 # + per-provider contribs
  webhooks.enable = true;               # a GitHub/Slack thread becomes a conversation
  scheduler.enable = true;              # cron-fired conversations
  byoc.enable = true;                   # bring-your-own-Claude, one option
  ui.enable = true;
  idleSuspendMs = 30 * 60 * 1000;
};
```

```bash
nix build .#platform-manifests && kubectl apply -f result
```

[`examples/kubenix-config.nix`](examples/kubenix-config.nix) is the maintained
kitchen-sink version — every feature on, heavily commented, and rendered by CI so
it always evaluates. [Getting started](https://chadac.github.io/scooter/getting-started/)
walks a real deployment.

## Architecture

Scooter layers over the Kubernetes
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller.
agent-sandbox provides the execution **body** — pods, warm pools,
suspend/resume. Scooter adds the **brain** (an ACP agent run outside the sandbox)
and a **conversation UI** (AG-UI + [assistant-ui](https://github.com/assistant-ui/assistant-ui)).
The agent drives the sandbox through the agent-sandbox API and the Kubernetes exec
API; nothing runs as an in-pod agent.

```
browser  (assistant-ui / AG-UI over SSE)
   │
   ▼
agent-host  ── spawns `goose acp` per conversation ── ACP⇄AG-UI bridge
   │  ├ SessionManager · ConversationStore (conversation-state PVC = brain)
   │  ├ MCP tools: slack/github/gitlab/jira · web search/fetch · background jobs ·
   │  │            model switch · sandbox resize · scheduled tasks · subagents
   │  └ web-service reverse proxy  →  /c/<id>/<service>/…
   │
   ├─ Kubernetes exec API (pods/exec) ──► Sandbox pod (body, NixOS · systemd PID 1)
   │                                        ├ workspace PVC (the agent's files)
   │                                        ├ overlay /nix/store (warm-pool PVC)
   │                                        ├ mcpServers.* · webServices.* (marimo ·
   │                                        │   VS Code · xterm) as systemd units
   │                                        └ scooter-* CLIs (rebuild, broker, service)
   │
   └─ broker (SA-token auth) ──► GitHub · GitLab · Jira · Slack · AWS ·
                                 Datadog · Grafana · Airtable

conversation-controller  the Conversation CRD · replica assignment · idle suspend
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
- **A self-modification must be reversible.** An agent's switch is gated on a build,
  registered as a generation, and rolled back automatically if it leaves failed
  units — so a bad module cannot brick the sandbox.

## Layout

| Path | What |
|------|------|
| `flake.nix` | Nix entry: sandbox image, agent-host, ui, broker, webhooks, scheduler, agent (goose), platform manifests |
| `services/agent-host/` | TypeScript: ACP⇄AG-UI bridge, session manager, K8s-exec backend, web-service proxy, MCP agent tools, auth |
| `services/broker/` | Python/FastAPI credential broker + provider registry |
| `services/webhooks/` | Python/FastAPI: spawn conversations from GitHub/GitLab/Jira/Slack threads |
| `services/scheduler/` | Python/FastAPI: fire cron-scheduled tasks, one fresh conversation per run |
| `services/claude-sdk-provider/` | Claude Agent SDK provider (an alternative brain to goose) |
| `pkgs/sandbox-os/` | The NixOS systemd-PID-1 sandbox image (exec via the K8s API) |
| `pkgs/broker-tools/` | Broker CLIs prebuilt into the sandbox: `agent-broker`, `git-credential-broker` |
| `modules/` | kubenix: per-conversation cold `Sandbox` (SA + 2 PVCs), the `Conversation` CRD + controller, agent-host, broker, webhooks, scheduler, warm pool |
| `modules/sandbox-os/` | The sandbox's own NixOS modules: `mcpServers.*`, `webServices.*`, the overlay store, and the three module layers that compose into a switch |
| `contrib/` | Integrations as self-contained packages (entry points into broker/webhooks, UI metadata, sandbox modules, agent skills) — `contrib/aws/` ships the `scooter-aws*` CLIs and its skill |
| `ui/` | assistant-ui frontend + reusable AG-UI client library |
| `skills/` | Markdown agent skills that document the PLATFORM (`scooter-intro`, `scooter-env`, `agent-tools`, `scooter-web-services`, …) — a skill documenting a contrib lives in that contrib, gated on it |
| `examples/` | Reference kubenix config + manifest checks |
| `test/` | Cluster-integration + e2e fixtures/fakes |
| `nixos-tests/` | NixOS VM tests for the sandbox image |
| `docs/` | The user-facing mkdocs site (the full `DESIGN.md`/`TESTING.md` are kept locally, outside the repo) |

## Subsystems

- **Self-modification (`scooter-rebuild`)** — the agent authors NixOS modules under
  its workspace and switches into them live: packages, env, systemd services. The
  build is the validation gate; generations and auto-rollback are the safety net.
- **MCP servers** — `mcpServers.<name>` renders both the systemd unit and the
  discovery manifest the agent-host reads, so an in-pod server becomes an MCP
  endpoint the agent's session can call. Loopback-bound by design.
- **Web services** — declarative in-pod services (marimo, browser VS Code via
  code-server, an xterm terminal via ttyd) that the platform reverse-proxies at
  `https://<host>/c/<id>/<service>/`. Started and stopped at runtime with the
  `scooter-service` CLI (or from the UI), and restored across suspend/resume.
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

[`just`](https://github.com/casey/just) is the task runner, and everything runs
inside the dev shell (`nix develop`, or direnv via `.envrc`) — the shell pins the
toolchain and the Playwright browsers, so running the suites outside it fails on
version mismatches.

**The tests are the spec** — run them to confirm changes rather than assuming.

```bash
just test-quick     # unit tests — contract seams against fakes, no cluster. Run constantly.
just test           # FULL suite: unit + cluster integration + e2e fast.
just ci             # What CI runs: flake + manifest/lockfile/hash checks + lint + unit.
```

Per suite:

```bash
just test-unit       # unit             (no cluster, no network)
just test-cluster    # cluster integration (vitest on real k8s; auto-starts one)
just test-e2e        # e2e fast         (Playwright through the UI; fake agent)
just e2e-full        # e2e full         (the same specs against a real k3d cluster)
just test-e2e-real   # e2e real-agent   (one scenario with REAL goose; needs a model key)
```

While iterating, run a targeted subset rather than the full suite —
`just e2e test/e2e/stop-run.spec.ts`, or `just e2e -g "queueing keeps thread"`. A
green subset is not evidence the branch is green. See [AGENTS.md](AGENTS.md) for
the full testing contract, including the flake-focus CI jobs and how to read the
`e2e-full` verdict.

Build:

```bash
just build           # agent-host + UI + sandbox image
just build-image     # just the sandbox-os image
just image-sizes     # measure shipped image sizes (JSON)
```

## Deploying

Scooter renders to ordinary Kubernetes manifests, so deployment is
`nix build .#platform-manifests` and your usual apply path — see
[Getting started](https://chadac.github.io/scooter/getting-started/) for
prerequisites (the agent-sandbox controller, an ingress controller) and
[`examples/kubenix-config.nix`](examples/kubenix-config.nix) for a complete config
to copy from. For local work against a real cluster, `just cluster-platform`
builds the images and stands the whole platform up on k3d.

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
