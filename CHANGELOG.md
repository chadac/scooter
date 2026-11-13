# Changelog

Each release's section becomes its GitHub Release notes. Images keep their
content tags and also gain `vX.Y.Z`; the flake is published to
[FlakeHub](https://flakehub.com/flake/chadac-me/scooter).

## v1.4.2

### Features

- **Run Scooter on one machine**: `nix run .#local -- up` brings up a k3d
  cluster, deploys Scooter from the published images and prints
  `http://localhost:8080`. It needs only Nix and Docker. (#1335)
- **Atlassian contrib**: `contribs.atlassian` puts one Atlassian OAuth app
  behind the forge proxy for Jira and Confluence, so agents use plain `curl`
  without holding a token (#1351, #1353). It adds Confluence tools, page
  auto-linking and a Confluence chip. (#1354)
- **Kanban prompt gates**: a gate can ask the card's agent to do something
  and answer whether it passed, with a note on the card. Prompt gates replace
  command gates, and existing command gates are migrated. (#1347)
- **Custom conversation retention**: a folder's retention menu takes any
  lifetime in hours, days or weeks, and its Default item shows the actual
  default. (#1338)
- **Merge blockers named**: `github_pr_summary` and `gitlab_mr_summary` say
  what holds a merge, which rules require it and who can clear it. The agent
  can resolve threads that have been answered. (#1349, #1350)
- **Docs**: a sample opens in a full-viewport view, and `samples/#<demo>`
  links straight to it. (#1356)

### Bug fixes

- **Slack writes work again**: the read-only forge policy applies only to
  `files.slack.com` and no longer blocks `slack.com/api`. (#1348)
- **Forge proxy**: paths with `.` or `..` segments, including encoded ones,
  never match a scoped API prefix or repo, so they get no token. (#1352)
- **Long conversations keep updating** after older history is paged in.
  (#1355)
- **The ui nginx drains gracefully on pod stop** instead of cutting open
  streams. (#1357)
- **The conversation controller waits a full window** before it scales
  agent-host down. (#1295)
- **The broker grants FGA tuples with `on_duplicate=ignore`**, which stops an
  OpenFGA error on every start. (#1345)
- **e2e**: cold-sandbox waits for the warm-up run to end before suspending.
  (#1344)

## v1.4.1

### Features

- **Kanban "For you".** The board header's For you narrows the lanes to what
  waits on the user: approval gates agents asked for, agents waiting on an
  answer, and linked PRs/MRs on cards short of the last stage. (#1314)
- **Kanban fits phones better**: the board header (#1313) and the card panel's
  tabs and nav (#1316) each fit on one row.
- **Code blocks in the thread are syntax-highlighted**, colouring as they
  stream. (#1329)
- **Shell and tool cards start folded**, with the command named in the header,
  and Ctrl-F still finds text inside them. (#1330)
- **Web services run as the agent, with its environment**, so the web terminal,
  Jupyter, marimo and VS Code reach the forge proxy, the SSH agent and cloud
  credentials, and keep their state across pod rebuilds. (#1331)

### Bug fixes

- **Releases hold app pods until their migrations are applied**, so readers no
  longer hit missing tables during a rollout. (#1326)
- **Stateless Deployments have PodDisruptionBudgets and topology spread**, so a
  node drain no longer evicts every agent-host replica at once. (#1320)
- **Cold starts**: tool calls wait out a cold start on one shared pod wait
  instead of failing after 90s (#1322), and a run isn't retried once its
  sandbox's pod wait has failed (#1323).
- **Sandbox exec retries a 5xx upgrade**, and logs a 404 (pod gone) at info.
  (#1318)
- **The broker stays healthy**: TokenReview runs off the event loop with a
  timeout (#1327), and http-proxy upstream timeouts and transport errors return
  504 and 502 instead of a bare 500 (#1319).
- **Each Slack thread gets its own link**, not one per channel. (#1332)
- **Quieter logs**: goose's `$/cancel_request` is dropped before the ACP SDK
  (#1324), a requested goose stop logs at info (#1321), an unset GCP key logs at
  info (#1317), and a link agent-host rejects is now logged (#1333).
- **The warm-store controller drops the legacy pool-state PVC sweep.** (#1315)

## v1.4.0

### Features

- **Kanban stage gates.** A board's stages can require the user's approval or a
  passing command (e.g. the tests) before an agent moves its card on. When the
  user moves a card past a command gate, the board offers to have the agent run
  it. (#1297, #1303)
- **Board skills.** Under Edit board, a board's skills (conventions, release
  steps) are given to every conversation filed on it. (#1282)
- **Kanban is easier to use**: click anywhere on a card to open its chat
  (#1296), and the board fits phone screens (#1280).
- **Review a web app beside the chat.** The new web-review contrib frames the
  conversation next to the app under review, and notes pinned on the app wake
  the agent. (#1262)
- **JupyterLab with the chat in its sidebar**, an opt-in contrib driven through
  jupyter-mcp-server, so the agent's edits reach the open tab live. (#1309)
- **Sessions.** Sandbox services can start child conversations: each VS Code
  chat gets its own (#1268, #1270), and the web can start sessions and switch
  chats beside marimo (#1292). The "<app> + chat" page is shared as
  `webServices.<name>.chatPage` (#1308), and `/chat/<id>` has a compact density
  for narrow panes (#1311).
- **Videos play inline in the chat**, through a new `show_video` tool. (#1258)
- **Custom themes** from `scooter.ui.themes`, saved per account. (#1307)
- **Attachments reach the agent.** Uploads in GitHub, GitLab and Jira bodies
  and comments are forwarded as refs the agent can fetch (#1281, #1284), and
  Slack lists any file it couldn't forward (#1274).
- **GitLab MR pipeline results and state changes** reach the linked
  conversation. (#1265)
- **Conversations reopen faster.** The event stream resumes from the client's
  cursor instead of replaying the whole log (#1260, #1261), and conversations
  are cached in IndexedDB and painted while they sync (#1264).
- **See why a private conversation is tainted, and clear it.** (#1275)
- **Agents can grow their `/workspace` volume** with `expand_workspace`, online
  and without a restart. (#1290)
- **Open tabs are told when a new UI build is deployed.** (#1283)
- **Agents reply to and resolve files-viewer review threads** with
  `scooter-files`. (#1287)
- **A compact Session tab**: one-line sandbox status and resources, one-row
  services, and an Add service form that asks Scooter to build it. (#1299,
  #1304)
- **A Samples page** in the docs, with the scooter-demos videos. (#1300)

### Bug fixes

- **Webhooks answer forges before delivering**, ignore Scooter's own GitLab
  notes (#1263), and keep serving deliveries until the ingress drops the pod
  (#1291).
- **A pending choice card stays answerable after its pod moves.** (#1305)
- **BYOC sessions are offered the sandbox's MCP servers.** (#1310)
- **The taint check** no longer taints a conversation for going private, only
  for steering by someone other than the owner (#1272), and counts the user's
  linked forge accounts as theirs (#1273).
- **An agent writing `<title>` in prose no longer silences its replies.**
  (#1277)
- **The idle sweep can't suspend a conversation mid-turn**, and expected resume
  refusals are quiet. (#1289)
- **VS Code chat opens on the Scooter agent**, not Local. (#1266)
- **The Session tab's resources, size picker, restart and stop are back.**
  (#1294)
- **Settings → Hooks works**: `/user-hooks` and `/sandbox-sizes` are proxied to
  the agent-host. (#1306)
- **PRs and issues created with `gh` are linked with their title.** (#1285)
- **The Subagents panel's Stop ends and removes the child.** (#1278)
- **A chat no longer steals focus** from another frame or window. (#1267)
- **Sidebar**: titles truncate (#1279), the scroll position survives switching
  conversations (#1286), and the hover + is gone (#1302).
- **web-review screenshots no longer hang** on lazy-loaded videos. (#1301)
- **Flaky e2e tests fixed.** (#1271, #1288)

## v1.3.0

### Features

- **Kubernetes tools.** The new `contrib/k8s` gives agents `k8s_*` tools for
  one or more clusters. Reads answer at once; writes, exec and Secret reads wait
  for a human's approval in the conversation. The broker holds the credentials,
  so the sandbox gets no kubeconfig. (#1210)
- **Kubernetes writes can run as an impersonated user**, with the conversation
  and approver as audit extras, so the broker's ServiceAccount can stay on
  `view`. (#1225)
- **Math in chat.** The opt-in `contrib/math` renders TeX with KaTeX: `$$…$$`
  and `\(…\)` inline, `$$` blocks, `\[…\]` and `math` fences as display math. A
  single `$` stays literal. It is built on a new `ui.markdownSyntax` seam that
  lets a contrib add remark plugins. (#1220, #1223)
- **Linked PRs, MRs and issues show their number.** GitHub links read
  `#12 <title>`, GitLab MRs `!12`. Contribs draw their own links through a new
  `ui.linkView`. (#1236, #1244)
- **Conversations start without waiting for the sandbox.** The first prompt,
  uploads and the conversation itself no longer wait for a cold sandbox pod.
  (#1230, #1232, #1243)
- **Kanban boards load faster and update live.** Each lane loads its 50 most
  recently active cards in one read, and more as it scrolls; changes are pushed
  to open boards instead of polled. A board's cards are read in one join, and
  each request shares one database session. (#1208, #1221, #1251)
- **Edit board saves in one go.** Stages and tags are edited as a draft and
  saved in one request; leaving with unsaved edits asks first. (#1213, #1214)
- **Contribs can push changes to a user's open tabs**, instead of polling.
  (#1212)
- **Broker providers can read conversations and their folders** from the
  `agent_host` database directly. (#1224)
- **`scooter.agent.command` runs a custom ACP agent** in place of goose, and
  `E2E_AGENT_BIN` swaps the fake backend's agent in e2e tests. (#1235, #1231)
- **Faster agent-host and database reads.** A conversation is hydrated with
  single-row reads, hot paths stop reading whole event logs, unchanged users
  aren't rewritten on every request, `resource_links` is indexed by
  conversation, and `db-migrate` checks a copied table by its keys. (#1226,
  #1238, #1240, #1242, #1241)
- **Kanban setup is documented**, with a troubleshooting table. (#1237)
- **CI:** a PR labelled `e2e-target` runs only its new e2e-full tests (#1228);
  the merge queue fails fast on the first red required job (#1216); more jobs
  run on the faster onprem runners (#1219, #1222, #1227).

### Bug fixes

- **Interrupted turns resume.** A turn cut off by a lost agent container gets a
  follow-up prompt to continue (#1215), a brief BYOC socket drop no longer fails
  in-flight runs (#1218), and the startup resume scan backs off while Postgres
  is unavailable instead of skipping conversations (#1211).
- **Approval cards whose request is gone are dropped** instead of showing admin
  wording. (#1209)
- **Every CI re-run's result reaches the agent**, including a re-run that turns
  green. (#1229)
- **Refused or failed broker tool calls are reported as MCP errors**, not
  successes. (#1234)
- **Postgres is sized to its 1Gi limit**, and PgBouncer runs on the Postgres
  node so pooled queries don't cross sites twice. (#1239, #1249)
- **A kanban board reopens its card's chat on reload** from `?thread=`. (#1250)
- **The header's sandbox status pill is gone**; the Sandbox tab shows the same
  state. (#1247)
- **The VS Code web service no longer crash-loops**: code-server runs on
  nixpkgs' node. (#1253)
- **uv in the sandbox no longer copies a project into the Nix store.** uv-nix is
  bumped to 0.13.7-nix.4. (#1252)
- **agent-host shuts down cleanly**, ending open SSE streams instead of cutting
  them. (#1256)
- **The fast stack reports a fake sandbox as ready** instead of "starting"
  forever. (#1233)
- **Flaky tests fixed:** kanban e2e boards are cleaned up (#1246), the second
  e2e dev server has its own Vite cache (#1248), and scheduler tests wait on
  run state instead of sleeping (#1255).

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
