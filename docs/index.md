# Scooter

**NixOS for your agents.**

Scooter runs a fleet of coding agents on Kubernetes, and the entire thing — the machines
agents work on, the services they can reach, the credentials they can borrow, the models
they may use — is one typed Nix configuration. The same bargain NixOS makes for a machine,
made for an agent fleet: declarative, composable, reversible.

That is not a loose analogy. An agent's sandbox *is* a NixOS machine with systemd as PID 1,
and when an agent needs a new tool or a long-running service it authors a NixOS module and
runs a switch — registering a numbered generation, with auto-rollback if the new config
comes up broken.

| NixOS | Scooter |
|---|---|
| `configuration.nix` | one typed `agentSandbox.*` tree for the whole platform |
| `services.<name>.enable` | `mcpServers.<name>`, `webServices.<name>` |
| `nixos-rebuild switch` | `scooter-rebuild switch`, run by the agent, applied live |
| generations + rollback | the same ladder, literally |
| modules and overlays | `contribs.<name>` — an integration is a directory, not a patch |
| channels / flake inputs | a shared module registry agents attach from |
| options search | [the option reference](reference/options/index.md), generated from the modules |

Underneath, Scooter layers over the Kubernetes
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller: agent-sandbox
provides the execution **body** (pods, warm pools, suspend/resume); Scooter adds the **brain**
(an off-the-shelf ACP agent driven from outside the sandbox) and a **conversation UI**.

## What it does

- **Sandboxes are dev environments, not containers** - Unlike other
  projects, you don't need to manage the dev container. Agents install
  tools as needed and the platform optimizes its cache to make that as
  fast as possible.
  - **Agents run services**. Your dev environment is capable of
    spinning up local notebook containers like
    [marimo](https://marimo.io/) or [jupyter](https://jupyter.org/),
    run interactive web servers for immediate feedback on UI
    components, or run full web applications end-to-end.
- **Secure integrations** - A broker service provides agent
  **identity-controlled** access to services like GitHub, GitLab,
  Slack, AWS, etc. This protects your secrets from being leaked to
  agents and enables:
  - Gated approvals on protected actions
  - Audits on agent access
  - Lifetimes for access when needed
- **Unopinionated agent integration** - Scooter uses
  [goose](https://github.com/aaif-goose/goose) under the covers, which
  enables general agent execution supporting Bedrock, Anthropic,
  Ollama, OpenAI, OpenRouter, etc. It also provides alongside that:
  - **Direct Claude Code CLI** for local development, and
  - **Bring-your-own-claude** to connect your local Claude Code (via
    the SDK) to Goose.
- **Declarative to the bone** - the whole platform is a Nix flake: images, Kubernetes
  manifests (kubenix), and every configuration option in one typed module system.
  [The option reference](reference/options/index.md) is generated from it.

## Where to start

- [Getting started](getting-started.md) — deploy the platform to a cluster.
- [Features](features/index.md) — what's in the box.
- [Configuration options](reference/options/index.md) — every `agentSandbox.*` option, generated
  from the modules.
