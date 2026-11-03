# Changelog

Each release's section becomes its GitHub Release notes. Images keep their
content tags and also gain `vX.Y.Z`; the flake is published to
[FlakeHub](https://flakehub.com/flake/chadac-me/scooter).

## v1.0.2

### Features

- **The agent can check and narrow its own conversation.** New
  `conversation_status` and `make_conversation_private` tools. Going private
  is one-way; only the owner can share a conversation again. (#1058)
- **Bedrock image models are configurable in Nix.** The model list and region
  are options on `contribs.imagegen.backends.bedrock`. The default moves from
  the deprecated Titan v2 to Stable Image Core in us-west-2. (#1090)
- **Release PRs are tested in the merge queue.** A PR that changes only
  `VERSION` and `CHANGELOG.md` runs no checks of its own, so it can be queued
  once approved. In the queue it runs everything, including e2e-full and the
  heavy nixosTests, and must pass all of it. (#1092)

### Bug fixes

- **GitLab notes reach their conversation.** Notes on an MR or issue that was
  linked by URL were dropped when they had no @mention. (#1088)
- **Tool-result images show on collapsed tool cards**, such as a screenshot
  from `view_image`. (#1086)

## v1.0.1

### Features

- **Sandbox-declared MCP servers reach the agent.** A server declared under
  `mcpServers.<name>` in the sandbox config is now offered to the agent.
  (#1078)

### Bug fixes

- **The flake now publishes to FlakeHub.** v1.0.0 never got there: FlakeHub
  evaluates every system, and the aarch64-darwin outputs failed. The darwin
  nix-stubs lock and code-server release are added, outputs that only exist on
  Linux (the sandbox image, manifests, claude-code) are left out on darwin, and
  CI runs the same all-systems evaluation on every PR. (#1084)
- **`github_comment` posts where the agent means.** In a conversation linked to
  several PRs or issues, it takes a `target` and refuses to guess without one,
  instead of always posting on the oldest link. (#1085)

## v1.0.0

The first tagged release. Scooter has been running in production-shaped
deployments for a while; from here on, each release lists what changed since
the one before it.

What's in it:

- **Conversations** with agents that run outside their sandbox (goose, or
  bring-your-own Claude), with suspend/resume, history restore and
  multi-replica agent-hosts.
- **Sandboxes** that are full NixOS systems the agent can reconfigure, with
  web services (VS Code, marimo, a terminal, a files viewer) proxied to the
  user behind auth.
- **The broker**, which holds every credential and gates outside access
  through an auditable permission system, including a forge proxy for GitHub,
  GitLab and Google Cloud.
- **Integrations** as opt-in contribs: GitHub, GitLab, Slack, Jira, AWS, GCP,
  Grafana, web search, image generation and more.
- **Webhooks and a scheduler** that route forge, chat and issue-tracker events
  to the right conversation and run recurring tasks.
- **Declarative configuration** through the `scooter.*` module options,
  rendered to Kubernetes manifests with kubenix.
