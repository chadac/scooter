# Changelog

Each release's section becomes its GitHub Release notes. Images keep their
content tags and also gain `vX.Y.Z`; the flake is published to
[FlakeHub](https://flakehub.com/flake/chadac-me/scooter).

## v1.2.0

### Features

- **Kanban boards.** `/boards` shows a board's conversations as cards in
  columns, with the open card's chat beside the board. (#1150)
- **Boards and their stages are locked folders.** Kanban makes each board a
  locked folder and each stage a locked folder inside it, so a card's stage is
  the folder its conversation is filed in, and the sidebar shows the stages.
  (#1152, #1158)
- **Cards can be blocked by other cards.** A blocked card's agent can work in
  its stage, but can't move the card on until every blocker reaches the board's
  last stage. (#1171)
- **Tags on cards**, defined per board with a name, color and order in the
  board's edit mode. (#1170)
- **A New conversation tile at the top of each stage** opens a draft filed in
  that stage. (#1169)
- **Agents can add cards to a board and list its cards.** `handoff_spawn` takes
  a folder to file the new conversation in. (#1172)
- **A Details tab for the open card** shows and edits its stage, note,
  priority, tags, description and blockers. (#1178)
- **Contrib views.** A contrib can add its own view of conversations beside the
  chat, picked from a switcher in the header. (#1147)
- **Markdown and conversation links in the contrib SDK.** (#1179)
- **`echo`, a minimal contrib view at `/echo`**, as a reference for each
  contrib surface. (#1151)
- **Nested folders, static folders and folder lifetimes.** Folders nest up to
  3 deep; Starred and contrib-declared folders can't be renamed, moved or
  deleted; a folder can keep its idle conversations forever, 1 day, 1 week or
  30 days. (#1148)
- **The right panel updates live.** Session, Shares and linked resources come
  over one state stream per conversation instead of each tab polling. (#1133)
- **Long-idle sandboxes give back their volumes.** A sandbox suspended for 7
  days (`sandboxRetentionSeconds`) has its volumes deleted; the conversation
  and its history stay. (#1149)
- **The agent hears when its PR starts to conflict.** (#1180)
- **The agent is told why a command never started** when its sandbox pod isn't
  Ready: a volume that won't attach, an unbound PVC, a stuck image pull.
  (#1153)
- **HTML files preview in the files viewer**, in a sandboxed frame. (#1156)
- **Relayed approvers need a router user assertion.** An approver service
  account can no longer name any user as the approver. Off unless
  `scooter.auth.userAssertionSecret` is set. (#1168)
- **Hidden per-conversation variables for contribs**, kept in the webhooks
  database where neither the agent nor the UI reads them. (#1181)
- **Shared approvals for contribs.** `scooter_broker_lib.approvals` gives an
  approval contrib its request table, routes, expiry and card raising, and
  `scooter.approvals.<name>` is derived. (#1194)
- **Handoff and commit approvals use it**, so their cards work until decided or
  expired, however long ago the run ended. (#1203)
- **PgBouncer in front of the in-cluster Postgres**
  (`scooter.postgres.pooler`), on by default, so rolling deploys stay under
  `max_connections`. (#1199)

### Bug fixes

- **Sandbox updates wait for the pod to restart.** After a rollout, a running
  sandbox is no longer restarted mid-session to adopt the new template; set
  `sandboxUpdatePolicy = "immediate"` for the old behavior. (#1184)
- **The overlay Nix store is garbage-collected**, so sandbox volumes stop
  filling up, and each pass spends its budget only on paths in the upper layer.
  (#1188, #1204)
- **Sandboxes run Nix 2.35**, so flake evals stop copying the source tree into
  the store each time. (#1189)
- **`uv` is in the image and pinned to its nixpkgs**, so the first PyPI MCP
  server no longer builds it or downloads nixpkgs. (#1185, #1186)
- **Approval cards work after their run ends.** (#1193)
- **No stray Allow/Deny buttons on tool cards in the chat.** (#1196)
- **The sidebar "!" clears when a question is answered**, even after a failed
  database write. (#1197)
- **Postgres stops running out of connections.** `max_connections` is raised,
  agent-host shares one pool and the Python pools are smaller. (#1195, #1198)
- **The agent hears why a sandbox pod isn't Ready**, and `restart_sandbox` says
  more than "the wait gave up". (#1182)
- **A suspended conversation's sandbox isn't resumed by a cleanup timer.**
  (#1145)
- **Waiting for a sandbox restart finds its pod.** (#1142)
- **Writing a file into a new directory works**, and ACP error logs are
  redacted. (#1146)
- **A conversation's first sandbox no longer gets a "sandbox was deleted"
  note.** (#1155)
- **An errored BYOC run no longer gets handed off again.** (#1187)
- **A superseded AWS request withdraws its approval card.** (#1143)
- **Kanban:** the agent's status updates reach its card (#1157), it is asked
  for a status every run and after the user moves its card (#1162), and boards
  can be created without extra config (#1154).
- **Handoffs reach the owner's private conversations only from ones the owner
  wrote entirely**, and start on the default model. (#1159, #1167)
- **Folders:** a folder's count stays visible after reordering (#1144), and a
  drop lands where it was dropped (#1163).
- **The header's conversation actions fold into a menu on phones.** (#1190)
- **Share files are served with a CSP sandbox** (#1164), and zip and
  multi-file shares are disabled until they work behind the login proxy
  (#1173).
- **BYOC:** a device keeps its session id across a controller restart (#1141),
  the ingress serves only the container's routes (#1165), and Settings lists
  and revokes devices again (#1166).
- **`flake.lock` bumps regenerate the darwin stubs too.** (#1191)
- **An orphaned ephemeral Postgres is stopped on the next start.** (#1183)
- **CI:** a failing nixosTest leg fails the `nixos` gate (#1205), and flaky
  tests are fixed (#1160, #1161, #1202).

## v1.1.0

### Features

- **MCP servers from Settings.** Users can list npm, PyPI and nixpkgs MCP
  servers in Settings; each of their sandboxes starts them and offers their
  tools to the agent. (#1121)
- **The Session tab lists the conversation's MCP servers**, with whether each
  is running and the tool prefix it reaches the agent under. (#1132)
- **Skill providers.** A deployment or contrib can hand conversations skills at
  runtime, from a script run in the sandbox before each agent run. (#1119)
- **Sandbox skills and skill sources.** The new `contrib/skills` adds the
  `scooter-skills` CLI: the agent can write its own skills under
  `~/.scooter/skills/`, or install them from sources. (#1118)
- **Handoffs.** The agent can hand a task to a new conversation, search and
  read past shared conversations, and move files between sandboxes. (#1123)
- **The agent can recall its user's private conversations too**, when it is
  working in one of that user's private conversations. (#1124)
- **A narrow route for services to start conversations.** The broker can open a
  conversation for the source conversation's owner without the power to act as
  any user. (#1122)
- **Docker and k3d in the sandbox.** `contrib/docker` runs a nested dockerd, so
  the agent can build images, run containers and bring up a local Kubernetes
  cluster. (#1126)
- **Sidebar folders.** Conversations can be filed in folders, and Starred is a
  built-in folder every user has. (#1125)
- **Folder icons and new conversations in a folder.** A folder can show a
  Lucide icon, a new conversation can start inside a folder, and the headers
  are tidier. (#1136)
- **Folders can be reordered**, by drag or with Move up / Move down in a
  folder's menu. Starred always stays first. (#1138)
- **The agent hears when its AWS approval card is answered**, so it no longer
  has to poll, and wakes up if it had ended its turn. (#1115)
- **Personal credentials stay out of tainted private conversations.** A private
  conversation that holds text someone else wrote (a webhook event, a message
  from while it was shared, a subagent's parent prompt) no longer gets the
  owner's forge token or SSH key. (#1114)
- **CI's k3d bring-up is faster**: `nixpkgs#` is pinned, and the deps build
  overlaps with starting the cluster. (#1120)
- **The nightly CI run is dispatched by a Scooter scheduled task**, since
  GitHub's cron fired hours late or not at all. (#1131)

### Bug fixes

- **Deleted conversations stay deleted.** A metadata backfill could put one
  back from a replica's stale file store. (#1110)
- **Fake-agent replies to `~call`, `~model` and `~images` get a title**, so they
  no longer trigger a second reply that made tests flaky. (#1111)
- **Links, approval cards and the resource map are served to services only.**
  With auth enforced, those routes now need a service token. (#1112)
- **A prompt to a suspended conversation is saved before its sandbox revives**,
  so it shows on reload and isn't lost if the host exits during a cold start.
  (#1113)
- **A message sent while a run is starting no longer cancels it**; it waits for
  the run's prompt to be sent first. (#1128)
- **Small PyPI MCP servers use far less memory.** uv-nix 0.13.7-nix.2 builds
  only the libraries a venv can use; `mcp-server-fetch` drops from 3.2 GB to
  about 690 MB. (#1135)
- **Conversations start without waiting for the sandbox.** The agent session
  starts at once, and the sandbox's MCP servers join on a later run when the
  pod was still starting. (#1137)

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
