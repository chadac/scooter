# TODO

Running list of work items. Newest asks at the top of each section. See
`docs/DESIGN.md` / `docs/TESTING.md` for architecture and test tiers.

## In progress

- [~] **Chat-window reliability — live SSE + integrity checksum.** SERVER DONE +
  CLIENT lib done; UI reconciliation works in isolation but is flaky in the
  shared-server e2e suite — needs a better render primitive before it lands.
  Bug: a webhook-spawned (or other-tab) conversation's agent reply doesn't show
  in an open UI window until refresh — the UI only streamed runs IT started.
  - [x] Rolling integrity checksum module + tests (`integrity.ts`, 857d49d).
  - [x] Server: store is the checksum authority (readEventsWithChecksum +
        onAppend, folded in write order); GET /history returns the checksum;
        new GET /conversations/:id/events.integrity replays + streams live with
        checksums (plain JSON SSE, not @ag-ui-encoded). 404 on unknown conv so
        the client stops reconnecting. (commits 77ef7f5, b712f20, 9cf97aa, 58c3844)
        + nginx /agui+/conversations made SSE-safe (no buffering). 45/45 Tier 1.
  - [x] integrityStream.ts client (subscribe, fold, checksum self-heal). VERIFIED
        live against the real stack: every event link_ok, message present.
  - [ ] **UI reconciliation is the open part** — parked on branch
        **`wip/integrity-ui-reconciliation`** (commit 9cc4e62). Wiring the
        integrity stream into RuntimeProvider via full `runtime.thread.reset()`
        works in a single e2e run (live-stream.spec passes in isolation — the
        reported bug IS fixed) but FLAKES in the full shared-webServer suite:
        reset() per-update fights assistant-ui's own render, and each open page
        holds a long-lived SSE that stresses the single-process test server.
        NEXT: replace full reset() with assistant-ui's incremental
        `import()`/`append()` so we apply deltas instead of rebuilding the thread
        each update. (Server side is on main + solid.)

- [x] **Durable webhooks mapping store (Postgres).** DONE — deployed + verified.
  The PR/Slack ↔ conversation mapping was SQLite on an emptyDir (wiped on every
  restart). Now a PVC-backed Postgres pod (`agent-webhooks-db`, ebs-gp3 1Gi);
  the app assembles the DSN from DB_* env (password via secretKeyRef). All 5
  tables created in Postgres, verified live. (commits c9eba33, mkMerge fix.)

## Backlog

- [x] **ACP-expanding tools — agent-presented option dropdown.** DONE end-to-end
  (commits ec74448 server scaffold → 74b0566 full interrupt feature). The agent
  presents options and blocks on the pick using assistant-ui's NATIVE interrupt
  mechanism: a request_permission pauses the run as RUN_FINISHED {outcome:
  interrupt, interrupts:[{id, reason, message, metadata:{options}}]}; the UI's
  InterruptPanel reads runtime.unstable_getPendingInterrupts() → inline buttons →
  unstable_submitInterruptResponses() → POST /agui resume[] → bridge resumes the
  blocked ACP call. KEY FIX: PERMISSION_RESOLVED is persist-only (not a standard
  AG-UI event — broadcasting it makes the @ag-ui client reject the stream).
  fakeAgent "?<prompt>" exercises it. 2 contract + 2 e2e tests, all green, 55/55
  Tier 1. (First assistant-ui UI feature to land green — the native interrupt
  primitive was the right call.)
  - [ ] Slack-surfacing of permission requests (deferred): when a conversation
        came from Slack (tracked in the webhooks store), also post the request +
        options to the Slack thread so the user can respond there. Separate path.

- [~] **Broker permissions / approval system (AWS).** PoC stages 1-3 DONE
  (commits dc5b56c, 73ed00c). Dynamic, approval-gated AWS access — an agent
  requests a scoped IAM policy, a human approves, the broker provisions a
  short-lived dynamic IAM role (cross-account assume-role + ExternalId +
  permission boundary + chained STS) and vends ephemeral STS creds. Ported from
  the OpenHands agent-token-broker (`~/code/gitlab.com/x.studio/devops/itops-infra/`).
  See docs/AWS_PERMISSIONS_BROKER.md.
  - [x] Research + design + red-first tests: `broker/aws/` (models, policy [the
        security core, FULLY ported — 19 guardrail tests GREEN], iam/store/service
        boilerplate, aws-permissions transport). 10 lifecycle tests RED-first
        define the contract. Decisions: full port MINUS Slack, in-conversation
        approval via the AG-UI interrupt mechanism, pluggable admin auth, store on
        the SHARED Postgres (agent-webhooks-db, separate `broker` DB).
  - [x] Stage 5 CORE done (commits 948ac2a, c13b773, 25cdcb5): store (SQLAlchemy
        async, shared Postgres), service (full lifecycle + cred cache), iam (boto3,
        cross-account assume + boundary + chained STS), policy, cli render,
        transport routes, the @register_provider factory + app lifespan wiring.
        39 AWS tests green (policy 19 + service 10 + cli 3 + iam-moto 4 +
        transport 3). The credential-helper entry point design is in the doc.
  - [x] Stage 5 CODE COMPLETE (commits fea94dc, b524216, c5cc90f): cli mains
        (credential_process helper + request CLI, --render-config); broker→host
        notify → bridge.raiseInterrupt (standalone AG-UI interrupt) → InterruptPanel
        → resolveAwsRequest → broker approve/deny; modules/broker.nix aws.* wiring
        (enable, accounts ConfigMap, DB secret, IRSA SA annotation, env);
        sandbox image ships scooter-aws + scooter-aws-credentials (embeds the
        broker cli.py) + awscli2/python3, renders ~/.aws/config at entrypoint.
        56/56 agent-host Tier 1, 41 broker tests green; sandbox image builds.
  - [ ] Stage 5 REMAINING: deployment config (enable broker.aws with the
        account registry + brokerPrincipalArn + DB secret) + build/push the broker
        + sandbox images + apply; a cluster e2e proving the full chain. Mount the
        accounts ConfigMap into the sandbox (conversation template) + set
        AWS_ACCOUNTS_FILE. GATED on the EXTERNAL AWS IAM below.
  - [ ] EXTERNAL (deployer/AWS): per target account, the `agent-token-broker-base`
        role + `agent-broker-permission-boundary` policy (trust = our broker IRSA
        + ExternalId); the broker IRSA needs sts:AssumeRole on those. Account
        registry as broker config.
  - [ ] CLEANUP (pre-existing, not AWS-specific): the broker test suite has
        global-singleton isolation fragility — the test/echo provider's mount
        depends on settings-singleton timing (its _mounts_ test fails at baseline);
        tests pass individually + per-AWS-file but the FULL suite in one process
        pollutes. Make provider mounting read settings at factory time (or a
        per-test settings fixture) so `just`/CI run the whole suite clean.

- [ ] **Storage consolidation onto a single store.** We have several stores: the
  webhooks mapping DB (`agent-webhooks-db` Postgres), the agent-host conversation
  state (PVC: JSONL event log + meta), and the new AWS permissions store.
  Step 1 (in progress): the AWS broker store reuses the SAME Postgres instance as
  webhooks (separate `broker` database) — no second Postgres pod. Step 2: rename
  `agent-webhooks-db` to a neutral shared name (it's no longer webhooks-specific).
  Step 3 (evaluate): move the agent-host conversation store onto Postgres too, so
  there's ONE durable backend to operate/back up.

- [ ] **Show linked resources in the chat UI.** We already track conversation ↔
  external-resource links (`ConversationMap` / `ResourceLink`: github PR/issue,
  gitlab MR, slack thread, jira ticket). Surface them in the left chat panel
  under a collapsing tab: provider icon + link, e.g. GitHub icon + PR link,
  GitLab icon + MR link, Slack icon + thread + a brief header/summary of the
  conversation. Needs: an agent-host endpoint to expose a conversation's links
  (sourced from the webhooks store, or have the webhook push the link to the
  agent-host on create — there's already a `/conversations/link` route), and a
  collapsible UI component.

- [x] **Conversation titling — agent-assigned.** DONE (commit 8089cd3). The
  agent emits a `<title>…</title>` marker as its first action; the bridge
  extracts it (streaming-split-safe), strips it from the shown text, and calls
  setTitle. Identity prompt instructs it; fakeAgent exercises it; the UI's 10s
  merge poll surfaces it without a refresh. Also fixed a latent durability bug
  (start() now awaits saveMeta). 53/53 Tier 1.

- [~] **UI emptiness during agent-host restart.** PARTLY addressed by the new 10s
  `loadConversations` poll (commit 8089cd3) — a fresh tab repopulates within 10s
  once the server is back. A retry-with-backoff on the *initial* load would still
  make the very-first paint snappier during a restart, but the poll covers the
  worst of it now.

## External (provider config — outside the cluster)

- [ ] Point the **GitHub App** (id 3515015) webhook URL →
      `https://scooter.example.com/webhooks/github` (secret = github-app
      `webhook-secret`; events: issue_comment, issues, pull_request). Likely
      still points at the old OpenHands receiver.
- [ ] Point the **Slack app** Event Subscriptions URL →
      `https://scooter.example.com/webhooks/slack` (subscribe app_mention +
      message.channels). URL verification challenge already confirmed working.

## Done (recent)

- [x] Agent option dropdown: AG-UI interrupt round-trip + InterruptPanel UI
      (commit 74b0566) — first assistant-ui UI feature landed green.
- [x] Conversation titling: agent-assigned via a <title> marker the bridge
      extracts + strips (commit 8089cd3).
- [x] Durable webhooks mapping store (Postgres), deployed + verified.
- [x] Webhooks: GitHub + Slack providers wired, Traefik ingress at
      scooter.example.com, `!scooter` / `scooter` triggers (commit 3da8187,
      deployed + externally verified).
- [x] Session persistence: ordered history log, delete-don't-tombstone,
      localStorage + server hydrate, e2e coverage (commit c5d6508, deployed +
      live-verified).
- [x] Scooter authored a real PR (#203) end-to-end via the broker.
