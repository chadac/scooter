# Changelog

Each release's section becomes its GitHub Release notes. Images keep their
content tags and also gain `vX.Y.Z`; the flake is published to
[FlakeHub](https://flakehub.com/flake/chadac-me/scooter).

## v1.0.3

### Features

- **Slack threads hear when the agent is waiting.** When a conversation started
  from Slack asks a question or needs an approval, the question and its options
  are posted to the thread with an "Answer in Scooter" link. (#1095)
- **Pending questions can be answered from Slack.** A question one click can
  answer (a single, single-pick question or a plain approval) gets a button per
  answer in the thread. Only the conversation's owner can answer. (#1098)
- **The right panel has two tabs.** "Sandbox" becomes "Session", which stacks
  Services, Subagents and each contrib panel as collapsible sections, next to
  Approvals. (#1102)
- **CI's fast checks run as three parallel jobs**, so they take less time per
  PR. (#1096)
- **CI no longer re-runs on `main`.** The merge queue already tested the commit;
  the `main` badge now shows that run's verdict. (#1100)
- **CI's Nix matrix jobs share the work with on-prem runners**, alternating
  entries with ubuntu-latest. (#1104)

### Bug fixes

- **CI results reach PRs opened from a fork.** CI-failed and green-again
  notices now reach the conversation behind a fork PR. (#1099)
- **A conversation's fenced pod stops all of its runs.** When a pod loses the
  right to write a conversation, every bridge it had wired to it stops, not just
  the current one. (#1091)
- **Idle subagents no longer take down their parent's sandbox.** The
  controller stopped reading a suspended subagent's shared sandbox as a zombie,
  and a parent whose subagents are all suspended can now idle-suspend. (#1097)
- **`scooter-rebuild switch` keeps the sandbox's container config.** The
  terminal, sshd, the overlay store and the warm-store units survive a rebuild.
  (#1101)
- **The agent hears when its PR drops out of the merge queue**, with GitHub's
  reason and what to do next. (#1103)
- **A slow sandbox start no longer leaves an invisible run.** Setup has its own
  5-minute budget, and a run ended during setup never sends its prompt. (#1089)
- **`view_scheduled_task` shows the whole prompt**, so a long prompt can be
  edited without losing its hidden part. (#1105)
- **CI comments appear on fork PRs.** They are now posted by chadac-bot. (#1106)
- **A new sandbox is Ready only once its PATH works**, so an early command no
  longer fails with `command not found`. (#1087)
- **Pending questions reach the Slack thread.** The broker routed the
  question notice to Slack's API and it 404'd, and webhooks calls to the
  agent-host had no token, so answer buttons refused every click. (#1108)
- **Older Slack conversations get their questions too.** A conversation with
  no stored Slack link now finds its thread from the webhooks mapping. (#1109)

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
