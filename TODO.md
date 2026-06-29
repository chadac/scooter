# TODO

Running list of work items. Newest asks at the top of each section. See
`docs/DESIGN.md` / `docs/TESTING.md` for architecture and test tiers.

## In progress

- [x] **Two live bugs found while testing the dev-env cutover (both fixed + deployed).**
  - [x] **Pod leak** (commit beceac3): hydrate() assumed a restart meant pods were
        gone -> marked all conversations 'suspended' -> idle sweep (running-only)
        never reclaimed the still-running pods (24 'suspended' in-memory vs 9 pods
        Running). Fix: provisioner.reconcile() lists live conv-* Sandboxes +
        replicas; hydrate() marks still-running ones 'running' so the sweep
        reclaims them. Cleaned up 7 stale pods (suspended -> PVCs kept). Deployed.
  - [x] **Webhook didn't trigger a response** (commit 3351cfe): the bridge had NO
        concurrency guard — a 2nd prompt mid-run clobbered the single RunState, so
        the first run's open TEXT_MESSAGE never got END and RUN_FINISHED fired with
        it open (@ag-ui client rejects -> reply lost). Webhook POSTs /agui while a
        run is in flight -> the collision. Fix: serialize prompts via a runChain
        promise (each run completes before the next RUN_STARTED). Red-first test.
        Deployed. RE-TEST the webhook trigger.
  - [x] **Second mention did nothing** (commit 0cab66e, regression from the
        pod-leak fix): hydrate marks a still-running conversation 'running' but it
        has no live bridge; prompt() gated revive on status!=='running' so it
        skipped revive and bridge?.prompt() silently no-op'd. Fix: revive on
        !bridge. Verified live (POST /agui to an existing conv now runs). Deployed.

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
  - [x] **Two server/client fixes landed on main** (commit b6e227c):
        agui/server.broadcast() scoped to run-scoped POST /agui conns (an external
        run no longer hits an idle @ag-ui client as a stray RUN_STARTED); and
        integrityStream retries a 404 with capped backoff (a lazily-created new
        thread connects once the user sends). 59/59 Tier 1.
  - [~] **UI reconciliation — parked on `wip/integrity-ui-import`** (commit 31d7e05,
        supersedes the older reset()-based `wip/integrity-ui-reconciliation`). Now
        uses the RIGHT primitive: `runtime.thread.import()` → `applyExternalMessages`
        (no run protocol, no RUN_STARTED, doesn't clobber interrupt/in-flight state).
        live-stream.spec passes IN ISOLATION. **Real blocker (measured): the Tier-3
        e2e suite is already flaky on pristine main** (~2 failed/2 flaky with ZERO
        changes — interrupt/linked-resources/revive/sessions shuffle run-to-run), so
        the shared suite can't validate this cleanly either way. NEXT: stabilize the
        e2e harness (below), THEN land import() (structural shape: hydrate via
        onSwitchToThread, stream appends-only). See docs/INTEGRITY_UI_NOTES.md.

- [x] **CI: split the dev-env nixosTests into a parallel matrix + enable KVM.** DONE
  (`.github/workflows/ci.yml`, PR #5). Two-part fix:
  1. SPLIT: the single `nixos-tests` job built all 8 VM tests SERIALLY (~1h, gated
     merges). Replaced with a `nixos-tests-matrix` job (evals `dev-env-*` names to
     JSON) + a `nixos-test` MATRIX (one VM test/job, fail-fast off, max-parallel 4,
     per-test cache key + shared-base restore prefix). Suite now finishes in the
     time of the slowest single test.
  2. KVM: the ROOT cause of the slowness — GitHub standard Linux runners HAVE KVM
     hardware but ship `/dev/kvm` with restrictive group perms, so qemu silently
     fell back to TCG software emulation (~6-10× slower; a VM that's ~44s locally
     took ~6 min in CI). Added the GitHub-documented udev rule
     (`MODE="0666"` on /dev/kvm) before the test runs → real hardware accel. (The
     `[ -e /dev/kvm ]` check passed all along — the device NODE existed, it just
     wasn't usable; that masked the TCG fallback.) Diagnosis confirmed by timing:
     matrix-on-TCG = ~2-7 min/test; with KVM 7/8 dropped to ~1 min. Still
     continue-on-error until confirmed consistently green, then promote to required.
  3. CACHIX + HEAVY-TEST SPLIT: the 8th test, `scooter-module`, builds a full
     SECOND nixos-system toplevel (193 extra drvs) from nixos-unstable — measured
     ~1h cold (recurs on every nixpkgs bump, not just per-branch). Two mitigations:
     (a) a `scooter` Cachix binary cache (cachix-action in `ci` + the matrix) so a
     given lock's closure is built ONCE and pulled across branches — NEEDS the
     CACHIX_AUTH_TOKEN secret + the `scooter` cache (DONE: secret set, cachix steps
     green, pushing). (b) the matrix enumerate job now EXCLUDES heavy tests
     (HEAVY_TESTS="dev-env-scooter-module") from per-PR runs — they run NIGHTLY
     (schedule cron) or on-demand when a PR carries the `full-nixos-tests` label.
     So per-PR nixos is uniformly the 7 fast (~1min) tests; the ~1h one doesn't
     gate PRs but still runs daily + is opt-in-able per PR. CONFIRMED: 7/7 fast
     tests pass ~1min with KVM; cachix push works. Still continue-on-error until
     promoted to required.

- [ ] **Stabilize the Tier-3 e2e harness (pre-existing flakiness).** Measured on
  pristine `main`: a full `just test-e2e` run is ~2 failed + 2 flaky with NO code
  changes; the failing set shuffles (interrupt, linked-resources, revive,
  sessions/new-session). Root cause: one shared single-process fake-agent webServer
  + vite, accumulating state and long-lived SSE connections across specs. This
  BLOCKS validating the live-integrity-UI feature (and erodes trust in the suite
  generally). Fix: isolate per-spec server state (or an isolated agent-host for
  SSE-heavy specs), make the SSE lifecycle + no-error-box afterEach deterministic.
  Deterministic Tier 1 (59/59) is unaffected — this is purely the e2e tier.

- [x] **Durable webhooks mapping store (Postgres).** DONE — deployed + verified.
  The PR/Slack ↔ conversation mapping was SQLite on an emptyDir (wiped on every
  restart). Now a PVC-backed Postgres pod (`agent-webhooks-db`, ebs-gp3 1Gi);
  the app assembles the DSN from DB_* env (password via secretKeyRef). All 5
  tables created in Postgres, verified live. (commits c9eba33, mkMerge fix.)

## Backlog

- [x] **OTel cost/usage metrics — exportable to any aggregator (Datadog, etc.).**
  DONE (agent-host; off by default). OpenTelemetry metrics over OTLP (vendor-neutral):
  `agent_runs_total` + `agent_run_duration_ms` (by model + outcome), `agent_tokens_total`
  (by model + kind: input/output/cache_read/cache_write), `agent_cost_usd_total` (by
  model), `agent_sandboxes` gauge (running/suspended), `agent_broker_requests_total`.
  - KEY RESEARCH FINDING: goose does NOT report token usage over ACP (PromptResponse
    carries only stopReason — goose issue #8132; our SDK v0.4.5 lacks the usage field).
    The TODO's "sees token counts in the ACP events" assumption was WRONG. SOLVED by
    reading goose's session DB instead: goose persists per-session token usage to
    `$HOME/.local/share/goose/sessions/sessions.db` (sqlite, the real schema has
    accumulated_{input,output,cache_read,cache_write}_tokens). The agent-host sets
    goose's $HOME, so it reads that DB out-of-band per-run and emits the delta.
  - Modules (services/agent-host/src/metrics/): `pricing.ts` (parse price table +
    computeCost = tokens × $/1M, unknown model → priced:false not a false $0),
    `gooseUsage.ts` (reads sessions.db via node:sqlite, introspects columns,
    degrades to "no cost" if DB/cols absent — never crashes), `metrics.ts` (OTel
    MeterProvider + OTLP exporter; no-op sink when disabled so call sites are
    unconditional; per-run delta accounting for cumulative usage). Wired: bridge
    onRunComplete hook (model/duration/outcome/acpSessionId), index.ts builds the
    sink, sweep reports sandbox counts, shutdown flushes.
  - Config (kubenix, NOT a helm chart — none exists; deployment is 100% kubenix):
    `observability.otel.enable` (off), `.env` (OTEL_EXPORTER_OTLP_* passthrough,
    SDK reads them), `.environment` (deployment.environment), `.pricing` (per-model
    $/1M → agent-pricing ConfigMap mounted at AGENT_PRICING_FILE). Verified the
    otel-ON render: env + ConfigMap JSON correct.
  - Tests: pricing.spec (8), gooseUsage.spec (4, against goose's REAL schema +
    graceful-degradation cases), metrics.spec (6, in-memory exporter: runs/tokens/
    cost/delta/gauge/no-op). 86/86 Tier 1. agentHost nix build green (npmDepsHash
    bumped for @opentelemetry/*).
  - NOT done (future): broker-side metrics (brokerRequest hook exists, unwired);
    if goose later fixes #8132, switch to the in-band ACP usage (more robust than
    the DB coupling). The sessions.db schema coupling is the main fragility —
    mitigated by column introspection + graceful degradation.

- [~] **CI: GitHub Actions running our checks on every PR.** DONE (workflow added);
  needs a throwaway PR to confirm green on the runner + branch-protection to make it
  required. `.github/workflows/ci.yml`: job `ci` (required) installs Nix
  (Determinate installer + magic-nix-cache, no secret) and runs `nix develop -c just
  ci` (flake check, check-manifests, agent-host + ui typecheck, Tier 1 vitest) plus
  `nix build .#broker .#webhooks` (their build runs pytest via pytestCheckHook); job
  `nixos-tests` (continue-on-error, KVM-gated) builds the dev-env nixosTests. Fixed
  along the way: (a) the `npm -w agent-host` → `npm -w services/agent-host` workspace
  selector in the justfile (npm 11 resolves -w by path); (b) a REAL torn-read race —
  fileStore now writes meta/activity/links ATOMICALLY (temp+rename) so a concurrent
  hydrate/list never reads a half-written file (was a 50%-flaky Tier 1 + a prod
  multi-replica hazard); (c) setTitle returns its persist promise so durability is
  awaitable; (d) the broker test-isolation CLEANUP below — discover_providers()
  refresh_settings() so create_app() is deterministic regardless of import order
  (`nix build .#broker` now green). REMAINING: open a PR, confirm the runner is
  green (esp. KVM for nixos-tests), set required checks. Tier 2/3 still out of CI
  (heavy; see e2e-stabilize).

- [ ] **UI: per-conversation model selection.** The backend already supports it —
  `availableModels` is configured, the management API accepts a model on
  POST /conversations and validates it via `resolveModel()`, and a conversation can
  override per-prompt. The UI just doesn't expose it. Add a model picker in the chat
  composer (and/or new-conversation flow): fetch the offered models from the API
  (GET /models exists), let the user pick, and send it with the prompt. Show the
  active model somewhere unobtrusive. Needs: a small assistant-ui composer addition,
  wiring the choice into the /agui or management call, and an e2e covering "pick a
  non-default model → it's used."

- [x] **E2E: concurrent tool-invocation reliability (parallel bash calls hang).**
  DONE — ROOT CAUSE FOUND + FIXED. The ACP terminal id was `term-${hash(command+args)}`
  (sandboxExec.ts), so two concurrent IDENTICAL bash calls got the SAME id; the ACP
  client's per-id `terminals`/`terminalBuffers` maps then clobbered each other — a
  later spawn overwrote the earlier handle, so `waitForTerminalExit` for the first
  call resolved against the WRONG (or no) handle → it hung / returned the other
  call's result. (Verified: with colliding ids, waitForExit(t1) returns t2's exit
  code.) Fix: unique per-spawn id (`term-${++seq}` monotonic counter), drop hashRef.
  Also extracted the fs/terminal handlers into a testable seam
  (`acp/sandboxHandlers.ts`, `createSandboxClientHandlers(exec)`) so concurrency is
  unit-testable WITHOUT spawning goose. Tests: exec.spec (distinct ids + independent
  resolution) + sandboxHandlers.spec (3 concurrent identical createTerminal → distinct
  ids, isolated output buffers, out-of-order independent exits, release-isolation,
  unknown-id non-hang). 68/68 Tier 1, stable across repeated runs.

- [ ] **Two lower-severity concurrency follow-ups (from the parallel-tool-call
  investigation).** Neither causes the fixed hang; both are latency/robustness.
  - [ ] **Deferred-connect in-flight dedupe** (`index.ts`, the
        `real ??= await connectSandbox(sandbox)` memoization): `??=` only caches the
        RESOLVED value, not the in-flight promise. So a burst of concurrent first
        tool calls each independently runs `connectSandbox` → `resolvePodName`
        (polls up to 90s for a Ready pod). Dedupe by memoizing the PROMISE
        (`pending ??= connectSandbox(...)`) so one connect serves the whole burst;
        a single pod-readiness wait instead of N.
  - [ ] **ACP stdio write ordering under concurrency** (`acp/client.ts`): all
        client-method responses are multiplexed over one stdio pipe + one
        `ClientSideConnection`. The SDK (`@zed-industries/agent-client-protocol`)
        owns write serialization; confirm a slow/blocked handler can't wedge other
        in-flight responses (the unique-id fix removed the handler-level block, but
        verify the transport itself doesn't serialize-and-stall). Likely fine; just
        needs a deliberate check (or a stress test) so we KNOW.

- [ ] **User identity — per-user sessions + a basis for permission-gating.** Today
  conversations aren't attributed to a user; anyone seeing the UI sees all sessions.
  Add user identity so (a) a user sees THEIR OWN previous sessions, and (b) we have
  an identity to permission-gate sensitive actions on (e.g. who may approve/request
  the AWS broker perms). Needs a design pass: auth source (the chat ingress already
  has basic-auth; or OIDC — reconcile with the broker's pluggable `is_admin`/
  approver-auth seam so identity is consistent across UI + broker), an owner field on
  the conversation record + store/migration, list-filtering by owner, and the UI
  surfacing only the caller's conversations. Then permission-gating (AWS approve/
  request, maybe conversation visibility) keys off this identity. Spec it (research →
  design → tests → impl); the auth-source choice + how it threads into the existing
  broker identity path are the key decisions. Related: the deferred "Broker
  permissions / approval system" + the admin-auth notes in docs/AWS_PERMISSIONS_BROKER.md.

- [~] **Deployment-injected tools (.scooter) — code complete, deploy gated on AWS auth.**
  A deployment adds its own Nix tools/services to the GENERIC sandbox with NO
  platform changes. Mechanisms (all green): `config.lib.mkLazyTool` (declare a lazy
  tool inline in any module; 3 resolve sources: pinned-attr / mounted-flake /
  pkgs.*); runtime `.scooter/module.nix` applied via switch-to-configuration (the
  module DECLARES its own tools — no enumeration, no image rebuild); generic
  `deployTools` provisioner hooks (scooterConfigMap mount + token audiences + env;
  no deployment-specific tool/credential concepts in the platform). nixosTests:
  mklazytool, injected-tool, scooter-module, lazy-stub all GREEN. Fixed a real
  prod bug: ship the nixpkgs source + modules tree in the image closure
  (cfg.nixpkgs is a context-less string) so the in-pod re-converge build is
  self-contained. DEPLOYMENT side done (in the deployment repo): .scooter/module.nix
  declares its review tool (over the deployment's credential mechanism), the tools
  ConfigMap, sandboxImage=OS + sandboxSystemd + deployTools wired; k8s-yaml renders
  clean. REMAINING: push closure-fixed OS + agent-host images to the registry,
  apply, start a conversation, confirm the tool works in the systemd sandbox.
  (Blocked: cloud auth token expired — re-auth needed.)

- [ ] **Conversation list: titles + linked-resource icons in the sidebar.** Today
  you have to open a conversation to see its title, and there's no way to spot
  which conversations have linked GitHub/GitLab/Slack threads from the list. Add:
  (1) surface the agent-assigned title in the listing (it exists — the <title>
  marker is extracted server-side; the 10s merge poll has it); (2) a small
  provider icon per conversation in the sidebar when it has a linked resource
  (the links are already stored + served via GET /conversations/:id/links and the
  LinkedResources panel). So the list shows title + a GitHub/GitLab/Slack glyph.

- [~] **Proper in-sandbox dev environment (Nix-powered, lazy, services-capable).**
  Modeled as a NixOS-config container (systemd PID 1). NixOS-config LAYER COMPLETE
  + PROVEN — all 5 nixosTests GREEN (commits d0ef8ff…4524987). See
  docs/DEV_ENVIRONMENT*.md + memory dev-environment-nixos-config.
  - [x] Research + Design + red-first nixosTests (Stage 1-3).
  - [x] **Lazy tool stubs** (`programs.lazyTools`, extensible; `uv` shipped): a PATH
        stub resolves the pkg from a pinned nixpkgs (ConfigMap pinFile / default) on
        first call, memoizes the /bin path by rev, execs it. Test stops the nix
        daemon to PROVE the cache hit ("slow only once"). [dev-env-lazy-stub]
  - [x] **systemd services** (`services.sampleDevService` sample unit): reaches
        active, opens a port, agent `systemctl start/stop`. [dev-env-service]
  - [x] **In-pod nix + skill** (`devEnvNix`): flakes, pinned `nixpkgs` registry
        (global registry off → deterministic), user nix-profile on PATH;
        skills/nix-dev-env.md teaches lazy tools + install + systemctl.
        [dev-env-nix-build-skill]
  - [x] **SPIKE — runtime re-converge** (warm-pod-specializes-on-claim): a generic
        pod live-switches to a pre-built specialisation via switch-to-configuration
        in ~1s, service comes up, systemd survives as PID 1. [dev-env-switch-specialisation]
  - [x] **OCI image builder** `pkgs/sandbox-os` — NixOS toplevel → OCI tarball
        (boot.isContainer, entrypoint=${toplevel}/init, container=docker, empty
        machine-id). ~339M. `.#sandbox-os-image`; cluster-up builds+imports it.
  - [x] **Tier 2 cluster test** (4/4 GREEN on real kind) — privileged pod boots
        SYSTEMD PID 1 under containerd (the #1 unknown, RESOLVED), is-system-running
        = running, nix-daemon active, sample service systemctl-controllable.
        test/cluster/sandbox-os.spec.ts. Also verified in-pod: uv lazy stub, nix.
  - [x] **Carry-over** broker/git-credential/aws-config -> NixOS units/packages
        (programs.scooterCarryOver, commit 90c091b). Verified in-pod: helper in
        /workspace/.gitconfig (systemd resets PID1 HOME to /root, so units write
        the agent's HOME explicitly). Tools on PATH.
  - [x] **CUTOVER DEPLOYED to the dev cluster (LIVE):** provisioner gained
        systemdImage (SANDBOX_SYSTEMD=1 -> privileged + tmpfs /run,/tmp, commit
        8d2b01b). Pushed agent-sandbox-os + agent-host to ECR; set the agent-host
        SANDBOX_IMAGE -> the OS image + SANDBOX_SYSTEMD=1. A REAL conversation
        provisioned a systemd NixOS pod (conv-fxh4j4: privileged, systemd PID 1,
        is-system-running=running), agent-broker whoami works (per-conv SA),
        Scooter ran a shell cmd and reported "running on NixOS with systemd PID 1".
  - [ ] **Retire pkgs/sandbox-image** once the OS image proves out in real use +
        update modules/conversation.nix (the kubenix mirror) to match the
        provisioner (systemdImage privileged/tmpfs) so rendered manifests agree.
  - [ ] (future) wire switch-on-claim into the agent-sandbox warm pool (claim→exec
        trigger); ConfigMap-driven services (`programs.lazyServices`, sibling of
        lazyTools). See memory runtime-nixos-switch-in-container.

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

- [~] **Broker permissions / approval system (AWS) — CODE COMPLETE, awaiting a
  live test with the user (the only remaining step).** Dynamic, approval-gated
  AWS access — an agent requests a scoped IAM policy, a human approves in the
  conversation, the broker provisions a short-lived dynamic IAM role (assume-role
  + ExternalId + permission boundary + chained STS) and vends ephemeral STS creds
  (consumed via ~/.aws/config credential_process). 98 tests green across both
  repos. Ported from the OpenHands agent-token-broker. See
  docs/AWS_PERMISSIONS_BROKER.md.
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
  - [x] Deployment config DONE: broker.aws block (account registry, DB secret,
        broker IRSA ARN) + the IAM-as-code Terraform (broker IRSA role +
        agent-token-broker-base + permission boundary). Approver-auth +
        sandbox/host ConfigMap mounts wired.
  - [ ] DEPLOY (gated on the IAM apply): (1) terraform apply the 3 IAM objects;
        (2) build+push the broker + sandbox images to the registry; (3) deployment:
        nix flake update + nix build .#k8s-yaml + kubectl apply; (4) the
        `broker` DB needs creating on agent-webhooks-db (CREATE DATABASE broker);
        (5) live e2e: agent runs `scooter-aws request`, approve in the UI, then
        `aws --profile <account> s3 ls` works.
  - [ ] EXTERNAL (deployer/AWS): per target account, the `agent-token-broker-base`
        role + `agent-broker-permission-boundary` policy (trust = our broker IRSA
        + ExternalId); the broker IRSA needs sts:AssumeRole on those. Account
        registry as broker config.
  - [x] CLEANUP (pre-existing, not AWS-specific): DONE — the broker test suite had
        global-singleton isolation fragility: `config.settings` was instantiated at
        import time, so the test/echo provider's `enabled=settings.test_provider_enabled`
        froze to whatever the env was at FIRST import; a later test setting the env
        was ignored, and the FULL suite in one process failed (whoami/git-credential
        routes 404). Fix: `config.refresh_settings()` re-reads env into the shared
        settings in place, and `discover_providers()` calls it, so create_app() builds
        providers against CURRENT env regardless of import order. `nix build .#broker`
        (full suite, one process) now GREEN.

- [x] **Storage consolidation onto a single store.** DONE (commit 06d6c4a +
  deployment 004f898). We had several stores: the webhooks mapping DB, the agent-host
  conversation state (PVC: JSONL event log + meta), and the AWS permissions store.
  - [x] Step 1: the AWS broker store reuses the SAME Postgres instance as webhooks
        (separate `broker` database) — no second Postgres pod. (Done earlier.)
  - [x] Step 2: renamed `agent-webhooks-db` → `agent-shared-db` (neutral — the
        instance hosts multiple logical DBs). Renamed the PVC/Deployment/Service +
        selectors and every host default across the webhooks + broker modules and
        the broker Python config/store. The password Secret keeps its legacy name
        (externally-managed cluster secret). nix build .#webhooks green; base
        manifest renders clean; broker shows only the known pre-existing isolation
        failures (45 passed). DEPLOY: a fresh `agent-shared-db` PVC is created on
        apply — the old `agent-webhooks-db` PVC/pod is orphaned (acceptable: no
        data to preserve, per the user); the `broker` DB still needs CREATE on the
        new instance.
  - [x] Step 3 (evaluated → SKIP): move the conversation store onto Postgres.
        Decided against: the conversation store is an append-only JSONL event log
        with a rolling integrity checksum folded in write order — the file store
        models that naturally; SQL would be Postgres-as-a-worse-filesystem (opaque
        event blobs) and wouldn't even reduce backends (the per-conversation
        sandbox PVCs remain either way). Not worth the complexity.

- [x] **Show linked resources in the chat UI.** DONE (commit b99046d). The
  webhook pushes the conversation's external resource link (GitHub PR/issue,
  GitLab MR, Slack thread) to the agent-host (POST /conversations/:id/links),
  which persists it per conversation (links.json) and serves GET …/links. The UI
  shows them in a collapsible Sidebar tab (LinkedResources — provider glyph +
  link, hidden when empty). github/slack handlers push on create. 59/59 Tier 1,
  2 e2e. (Future: a richer Slack thread URL + a brief summary header.)

- [x] **Conversation titling — agent-assigned.** DONE (commit 8089cd3). The
  agent emits a `<title>…</title>` marker as its first action; the bridge
  extracts it (streaming-split-safe), strips it from the shown text, and calls
  setTitle. Identity prompt instructs it; fakeAgent exercises it; the UI's 10s
  merge poll surfaces it without a refresh. Also fixed a latent durability bug
  (start() now awaits saveMeta). 53/53 Tier 1.

- [x] **UI emptiness during agent-host restart.** DONE (commits 8089cd3 + ff515b1).
  The 10s `loadConversations` poll handles the steady state; the initial load now
  retries with backoff (0.5s→8s) while the server is unreachable, so a fresh tab
  during a restart paints within a second or two of the agent-host coming back
  (loadConversationsResult distinguishes "down" from "up but empty"). 9/9 sessions
  e2e green.

## External (provider config — outside the cluster)

- [ ] Point the **GitHub App** (id 3515015) webhook URL →
      `https://scooter.example.com/webhooks/github` (secret = github-app
      `webhook-secret`; events: issue_comment, issues, pull_request). Likely
      still points at the old OpenHands receiver.
- [ ] Point the **Slack app** Event Subscriptions URL →
      `https://scooter.example.com/webhooks/slack` (subscribe app_mention +
      message.channels). URL verification challenge already confirmed working.

## Done (recent)

- [x] **Deployed to the dev cluster** (2026-06-24): storage rename (agent-shared-db) +
      new ui/agent-host/webhooks images (content-tagged, forced via `kubectl set
      image`). Created `broker` DB on the new shared Postgres; deleted the orphaned
      old `agent-webhooks-db` PVC/Deployment/Service. AWS broker held OFF at apply
      time (IAM not imported yet — see memory `aws-broker-iam-import-approach`);
      config keeps `aws.enable = true` as the intended end state. All 5 platform
      pods healthy; chat.dev (401 auth-gated) + scooter.dev/webhooks (405 on GET)
      both serving. Surfaced + fixed a real bug: **agent-host now uses Recreate
      strategy** (commit 4278e3c) — the default RollingUpdate deadlocked on the RWO
      agent-host-state PVC (Multi-Attach), new pod stuck ContainerCreating ~10min.
      deployment commit 73d409c; broker image NOT rebuilt (its image build is blocked
      by the pre-existing test-isolation failures — separate CLEANUP item).

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
