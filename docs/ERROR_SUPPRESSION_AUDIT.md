# Error-suppression audit

A multi-agent audit of every `try/catch` (TS), `try/except` (Python), and
`.catch()` site across the agent-host, broker, webhooks, and ui — hunting for
the **error-suppression anti-pattern**: a swallow that substitutes a default /
no-ops / returns a fallback where a real failure should instead propagate, be
logged loudly, or change behavior.

Method: 6 parallel area reviewers classified each site (SUPPRESSION /
LEGITIMATE / BORDERLINE); every flagged site was then independently re-checked by
a skeptic that read the surrounding code and defaulted toward rejection. Result:
**27 confirmed findings** (4 high, 12 medium, 11 low) vs **55 sites judged
legitimate** (correctly intentional — cleanup, idempotent already-exists,
best-effort telemetry, retries that re-raise).

> **Status: ALL 27 FIXED.** Each fix fails loud / surfaces the masked failure
> instead of substituting a default, with a regression test asserting the new
> behavior where the change is behavioral (the security/data-loss/leak findings)
> and observability (a loud log) where graceful degradation is the right call
> (best-effort telemetry, UI fetches). See the `fix(audit): …` commits. The
> guiding rule: ENOENT/404/already-exists = the ONE benign case (silent OK);
> every other error propagates or is logged. Verified: agent-host 119/119 Tier 1
> + typecheck, broker + webhooks pytest green via nix, ui typecheck.

## Summary

The audit surfaced 27 verified suppression sites, concentrated almost entirely in the agent-host (services/agent-host) and the credential broker (services/broker). The picture is a consistent "degrade silently" anti-pattern: bare catches that conflate the one benign case (file-not-found / already-exists / 404) with every real failure, then proceed as if nothing happened — with no log, metric, or health signal. The worst offenders are genuinely dangerous: (1) two fail-open / fail-closed authz+config bugs that silently break security boundaries — index.ts:230 lets goose run tools in the HOST pod instead of the sandbox when its config write fails, and authz.py:88 swallows an OpenFGA grant-write failure at DEBUG that then permanently locks an approver out (check fails closed); (2) two broker startup/config swallows (aws.py:34) and a dropped user approval (index.ts:354) that silently disable or lose security-relevant decisions; and (3) the conversation's sole persistence write chain (fileStore.ts:75) which drops a failed durable event-log append entirely. Below those, a cluster of resource-leak and silent-empty-history bugs round out the medium tier.

## Ranked findings

### 1. [🔴 HIGH] writeGooseConfig failure → goose runs tools in the HOST pod, not the sandbox (silent isolation breach)
`services/agent-host/src/index.ts:230`

**Problem.** On a real deployment, writeGooseConfig is the SOLE mechanism enabling goose's developer extension. A write failure ($HOME/.config/goose read-only/unwritable, perms) is downgraded to console.warn and startup proceeds. goose is spawned with args ['acp'] (no --with-builtin fallback) directly in the agent-host pod, so without the config the developer extension defaults to enabled=false and goose runs shell/read/write/edit tools LOCALLY in the agent-host process instead of redirecting them into the per-conversation sandbox. /healthz still returns 200, so the mis-isolated pod passes readiness and serves traffic.

**Fix.** On a real (!fakeSandbox) deployment treat the failure as fatal: rethrow / process.exit(1), or at minimum fail /healthz and emit a loud error metric. Never continue serving with developer-redirect silently off.

### 2. [🔴 HIGH] OpenFGA grant() swallows write failures at DEBUG → approver permanently locked out (fail-closed)
`services/broker/broker/core/authz.py:88`

**Problem.** grant()'s bare `except Exception` logs at DEBUG and returns None without re-raising, collapsing the one ignorable case (duplicate tuple) with every real write failure (FGA unreachable, wrong store_id, bad model_id, network error). The caller seed_approver_tuples wraps grant() in its own `except → logger.exception`, but that loud handler is DEAD CODE because grant() never propagates. Downstream check() fails CLOSED, so a tuple that was never written means the approver is permanently and silently denied approval of the account — a lockout/availability bug whose only signal is a DEBUG line. The sibling check() in the same file correctly uses logger.exception (WARNING+); grant() is the inconsistent one.

**Fix.** Detect the actual duplicate-write condition (inspect OpenFGA error code/status) and treat only that as a no-op; re-raise or logger.exception (WARNING+) for everything else so seed_approver_tuples' own handler surfaces it. Do not swallow persistence writes at DEBUG.

### 3. [🔴 HIGH] Corrupt/missing aws_accounts_file silently disables AWS provider despite aws_enabled=True
`services/broker/broker/providers/aws.py:34`

**Problem.** The unset-file case is already handled by an earlier early-return, so this try/except only fires when a path IS configured but open/json.load fails (bad path, perms, malformed JSON). Returning {} makes `enabled = settings.aws_enabled and bool(registry)` compute False even when the operator set aws_enabled=True; discover_providers then drops the provider, the broker boots 'healthy', and every credential request gets a misleading 503 'aws permissions not configured'. The logger.exception does not change startup success, health, or the 503 — the failure is behaviorally fully masked and indistinguishable from a deliberately-disabled provider.

**Fix.** When settings.aws_enabled is true, re-raise after logging so startup fails fast (or surface an unhealthy/degraded signal). Only the aws_accounts_file-unset branch should silently yield {}.

### 4. [🔴 HIGH] Durable event-log append failure silently dropped — conversation's sole persistence loses turns
`services/agent-host/src/session/fileStore.ts:75`

**Problem.** appendEvent's `.catch(() => {})` sits on the prior chain link (correct, to keep serialization ordering), but THIS append's appendFile rejection (ENOSPC/EACCES/unmounted conversation-state PVC) is never separately observed. The rejected promise is both returned to a fire-and-forget `void store.appendEvent(...)` caller (dropped, no log) and stored in writeChains where the next append swallows it via the same bare catch. Either way a failed write to the conversation's ONLY persistence vanishes with no log, metric, or health signal; live onAppend subscribers and history replay silently miss the turn. Contract tests await appendEvent so they'd catch it, but production never does.

**Fix.** Keep the line-75 chain-linking catch intact, but wrap the appendFile/notify body in its own try/catch that logs loudly and increments a per-conversation 'persistence-degraded' metric/health signal. A durable-write failure must leave a trace.

### 5. [🟠 MED] User's AWS approve/deny silently dropped on broker error (no res.ok check, fire-and-forget)
`services/agent-host/src/index.ts:354`

**Problem.** onAnswer calls resolveAwsRequest as `void deps.resolveAwsRequest?.(...)` (result discarded). resolveAwsRequest POSTs approve/deny to the broker but never captures or checks the fetch Response, so a broker 4xx/5xx (approver lacks rights, request expired) is silently treated as success and not even logged; the catch at 354 only console.warns on a thrown network error. In all failure modes the broker never records the user's decision — an approve leaves the agent's AWS request hanging unresolved while the user believes they answered. No retry, no res.ok check, no error re-surfaced into the conversation, no metric. A security-relevant decision is dropped while the system reports success.

**Fix.** Capture the Response, check res.ok, on failure log loudly with status+body, re-surface the failure back into the conversation/interrupt (don't dismiss it), and/or increment an error metric so a dropped approval is observable.

### 6. [🟠 MED] IAM role/policy teardown failure ignored by callers → orphaned live role + lying audit trail
`services/broker/broker/aws/service.py:261`

**Problem.** delete_dynamic_role/delete_dynamic_policy (iam.py:236/202) correctly log via logger.exception and return False on a non-NoSuchEntity failure (throttling, transient, partial detach). But all three callers — deny(:217), revoke(:255-261), sweep_expired(:269-273) — discard the bool and unconditionally store.update(status=DENIED/REVOKED/EXPIRED). list_expired_active selects only ACTIVE/APPROVED, so once flipped to terminal the request is never re-swept; there is no reconciliation/retry anywhere. A dynamic IAM role (with a trust policy letting the broker IRSA assume it) can be orphaned permanently while the DB records it torn down. (New-credential minting is gated on status==ACTIVE, so the leak is a resource/audit-drift bug rather than a live usable credential.)

**Fix.** Callers must check the bool: on False keep the request in a 'revoking'/error state (do NOT transition to terminal), let the next sweep retry, add policy-only orphans to sweep_expired, and emit a metric/health signal. Keep the broad log.exception in the iam.py helpers.

### 7. [🟠 MED] destroy() swallows non-404 Sandbox CR delete failure → orphaned Sandbox + pod + workspace PVC
`services/agent-host/src/session/k8sProvisioner.ts:152`

**Problem.** destroy()'s `.catch(() => {})` swallows ALL delete errors on the Sandbox CR, not just 404. Its caller end() (manager.ts:351-363) then unconditionally runs entries.delete(id) and store.removeConversation?.(id), dropping both in-memory and persisted references. A non-404 failure (stuck finalizer, API/RBAC error) leaves the Sandbox CR + pod + RWO workspace PVC running while the conversation is erased everywhere app-side — the leak is invisible and un-GC-able. The author already knows the correct pattern: create() narrows its catch to code===409 and rethrows everything else.

**Fix.** catch (e) and `if (e?.code !== 404) { log loudly; throw e; }` so end() does not optimistically drop the only references to a Sandbox that failed to delete.

### 8. [🟠 MED] destroy() swallows non-404 ServiceAccount delete failure → leaked per-conversation broker identity
`services/agent-host/src/session/k8sProvisioner.ts:161`

**Problem.** The bare `.catch(() => {})` on deleteNamespacedServiceAccount swallows non-404 failures (403 RBAC-denied, 500, conflict) on the per-conversation broker-identity SA (sandbox-{id}). The SA is created independently (not owned by the Sandbox CR), so deleting the Sandbox does not cascade-clean it, and the sole caller end() immediately drops all in-memory + persisted references with no tombstone/retry (reconcile only lists Sandbox CRs, never SAs). Result: stale broker identity + RBAC accumulate in the namespace on every ended conversation with no signal. Again, create() at lines 101-103 already shows the correct narrowed pattern.

**Fix.** Mirror create(): `.catch((e) => { if (e?.code !== 404) { log.error(...); throw e; } })` so SA leaks are visible/surfaced rather than silent.

### 9. [🟠 MED] Unreadable broker SA token masquerades as 'dev mode' → unauthenticated request → 401, approval lost
`services/agent-host/src/index.ts:343`

**Problem.** The inner `catch { /* no token (local/dev) */ }` is keyed on a missing file (dev) but treats ANY read error identically (EACCES on the projected SA token, decode error): the Authorization header is omitted and an unauthenticated POST is sent. The broker requires it (auth.py:39 raises 401 'missing bearer token'; aws_permissions.py approve/deny gate on authed), so a present-but-unreadable token yields a 401 and the AWS request is left silently un-resolved. This compounds the rank-5 problem (the outer fetch never checks response.ok).

**Fix.** In the inner catch, rethrow/log on anything that isn't ENOENT (only file-not-found is truly optional in dev). Separately, check response.ok on the fetch and surface non-2xx as a failed resolution.

### 10. [🟠 MED] hydrate() reconcile failure silently assumes ALL conversations suspended → pod leak (the exact leak reconcile prevents)
`services/agent-host/src/session/manager.ts:391`

**Problem.** reconcile() (a plain listNamespacedCustomObject that can transiently fail) is documented as the mechanism that prevents pod leaks across a restart. When it throws, the bare `catch {}` leaves `live` empty, so EVERY meta is set to status 'suspended' with empty namespace. sweepIdle only reclaims entries with status==='running', so any actually-running pod is never reclaimed — the precise leak the code exists to prevent — silently, with no log/health signal (the module imports no logger though the rest of the service uses console.warn/error).

**Fix.** Log at warn/error in the catch (operator needs to know reconcile failed and a leak is possible) and ideally surface a degraded/health signal, while keeping the assume-suspended boot fallback so the host doesn't crash-loop.

### 11. [🟠 MED] readEvents returns empty iterable on ANY read error → real conversation replays as blank history
`services/agent-host/src/session/fileStore.ts:99`

**Problem.** The bare catch returns an empty iterable for any readFile error, not just ENOENT. All three callers (onAttach replay, /history returning 200 {events:[],checksum:EMPTY_CHECKSUM}, events.integrity emitting 'synced' with no events) treat the empty result as a successfully-loaded empty conversation. On EACCES/EIO/transient PVC unmount a real populated conversation is silently presented as empty with a valid-looking EMPTY_CHECKSUM — no log, no degraded signal. (Dominant ENOENT case — brand-new conversation — is legitimately correct, which bounds the blast radius to the I/O-error case.)

**Fix.** Narrow to err.code === 'ENOENT' for the empty return; for any other code log loudly and rethrow (or surface a degraded/failed-load state) so the UI shows an error instead of fabricated empty history.

### 12. [🟠 MED] listConversations returns [] on any readdir error → entire conversation list vanishes after restart
`services/agent-host/src/session/fileStore.ts:159`

**Problem.** listConversations() is the sole input to hydrate(). The bare `catch { return []; }` (no comment, no log) conflates the legitimate first-boot ENOENT (root dir not yet created) with genuine infra failures (EACCES/EIO/ENOTCONN from a PVC that failed to mount). In those cases hydrate() populates zero entries and GET /conversations presents an empty world indistinguishable from a clean fresh install, with no operator signal. Not destructive (the on-disk JSONL is untouched and self-heals on the next successful hydrate), so it's a degraded-read smell rather than data loss.

**Fix.** Narrow to ENOENT → return []; for any other errno log loudly (and ideally surface a health/degraded signal) and rethrow so hydrate() fails visibly instead of silently showing zero conversations.

### 13. [🟠 MED] goose sessions.db open() catch uses debug() (off in prod) and discards err → cost metrics permanently disabled
`services/agent-host/src/metrics/gooseUsage.ts:109`

**Problem.** The catch logs via debug() (gated off in prod) AND discards `err` entirely, so a corrupt DB / perms error / SQLITE_BUSY / schema-mismatch-under-goose-upgrade is indistinguishable from the benign 'DB not created yet' and produces NO operator-visible signal. The failure is permanent: openedOnce is latched true before the try and open() short-circuits on every later call, so cost+token metrics stay disabled for the process lifetime with no retry. The sibling read-path catch (line 137) correctly uses debugError() ('always logged — worth surfacing') — this open-path is the inconsistent one. (Behavior omits cost rather than reporting a false 0, so it's an observability smell, not a wrong-value bug.)

**Fix.** Log the actual `err` at a visible level (debugError) and surface a degraded signal (e.g. a 'usage_reader_unavailable' metric/health flag). Optionally distinguish ENOENT (benign) from other errors so a corrupt/unreadable DB is loud.

### 14. [🟠 MED] waitForTerminalExit returns fabricated exitCode:1 on unknown terminalId → host bug masquerades as command failure
`services/agent-host/src/acp/sandboxHandlers.ts:80`

**Problem.** On a missing terminal-map handle, waitForTerminalExit returns a bare {exitCode:1} with no log. A missing handle means an internal bookkeeping defect (handle never registered, released early, id mismatch) — and this module's own docstring calls the terminal map the exact seam where a concurrency bug used to clobber handles. Returning exit 1 makes that host-side defect indistinguishable from a command that genuinely exited non-zero. The codebase already has debugError ('always logged') which isn't used here. (The early-return itself is intentional and unit-tested to avoid hanging on undefined; only the observability is missing.)

**Fix.** Call debugError with params.terminalId and Array.from(terminals.keys()) before returning, and optionally use a distinct sentinel (e.g. 127/-1 or reject) so an operator can tell a lost-handle bug from a real non-zero exit.

### 15. [🟠 MED] loadHistory returns [] on fetch/parse failure → reviving a real conversation shows blank thread
`ui/src/client.ts:173`

**Problem.** loadHistory's bare `catch { return []; }` (plus `if (!res.ok) return []`) conflate fetch/network error, non-2xx, and malformed JSON with a genuinely empty conversation. The sole caller treats history.length===0 as a no-op and shows a blank thread, so reviving a real conversation whose history fetch fails silently drops all prior turns and looks identical to a brand-new thread — no log, no console.warn, no retry/degraded signal. The sibling loadConversationsResult in this same file deliberately returns {ok, conversations} to surface ok=false on the same failures; loadHistory pointedly does not. (Recoverable — history still lives on the agent-host — so it's an observability gap, not data loss.)

**Fix.** Mirror loadConversationsResult: return { ok, messages } so the caller can distinguish 'no history' from 'failed to load' and show a retry affordance; at minimum console.warn the swallowed error.

### 16. [🟠 MED] Malformed SSE integrity frame silently `continue`d → dropped 'synced' marker strands UI in perpetual loading
`ui/src/integrityStream.ts:163`

**Problem.** catch{continue} silently drops any unparseable SSE frame with zero logging or health signal. The checksum self-heal only covers dropped *event* frames (apply() returns 'gap' on a prevChecksum mismatch, forcing reconnect+replay), but a dropped 'synced' frame is NOT healed — apply() handles kind==='synced' before any checksum check and never advances `running`, and the server emits {kind:'synced'} exactly once. So a corrupt/truncated synced marker is permanently lost: `synced` stays false, the thread shows perpetual loading with no error. Even for event frames, the operator never learns the agent-host is emitting corrupt frames. (Currently latent — no UI consumer imports subscribeIntegrity yet.)

**Fix.** Log the parse error (frame snippet + conversationId) and treat a parse failure as a 'gap' (abort + reconnect to re-replay from the seed) instead of a bare continue, so a dropped synced marker self-heals rather than stranding the view.

### 17. [🟡 LOW] get_conversation_status conflates 5xx/unreachable with 404 → status comments freeze with no degraded signal
`services/webhooks/webhooks/agent_host_client.py:139`

**Problem.** The catch collapses every HTTP failure (timeout, 500, connection refused) into the same None a real 404 returns; the caller omits the conv and _poll_once treats None as 'no change, skip'. It DOES log (logger.warning) and the polling loop self-heals transients on the next cycle, so the only real gap is a SUSTAINED agent-host outage: status comments freeze on their last value (e.g. RUNNING) with no degraded-health signal beyond the per-call warning.

**Fix.** Distinguish transport/5xx from a real 404 (return a sentinel or raise on non-404) so the monitor can surface a degraded/errored health signal on repeated failures instead of indefinitely freezing status.

### 18. [🟡 LOW] Idle-sweep suspend failure swallowed with no log → chronically-unsuspendable conversation leaks a pod silently
`services/agent-host/src/session/manager.ts:430`

**Problem.** The empty catch swallows every error from suspend() — bridge.stop() (goose wedged on close) and provisioner.suspend() (k8s Sandbox patch rejected) — with no log or metric. The only caller logs successes but nothing for failures, so a chronically-unsuspendable conversation leaks a running pod forever with zero visibility. The 'retried next sweep' comment only holds while the conv stays idle and status stays 'running'; it does not bound a persistent failure. (Genuinely best-effort — one failed sweep is not a correctness bug and the loop correctly continues — so the defect is purely the missing observability.)

**Fix.** Log the per-entry failure at warn with the conversation id (idiomatic here — the service already does this for similar degrade-don't-break failures); optionally track consecutive failures as a metric. Leave the swallow so one bad entry doesn't abort the sweep.

### 19. [🟡 LOW] delete_dynamic_policy failure ignored by callers → orphaned IAM policy, state drift (lesser sibling of rank 6)
`services/broker/broker/aws/iam.py:202`

**Problem.** Same caller-ignores-bool pattern as rank 6 but for policies: NoSuchEntity→True is correct idempotency, and a real failure logs via logger.exception, but deny()/revoke() ignore the returned False and unconditionally transition status to DENIED/REVOKED, leaving the dynamic policy orphaned while recorded state says it's gone. Lower severity than the role leak: a detached managed policy with no principal attached grants zero access, so this is cost/audit drift, not live security exposure.

**Fix.** Fix lives in the callers (covered by rank 6): treat False as non-terminal — flag for the background sweep / retry — and add policy-only orphans to sweep_expired. The logger.exception in the helper is fine.

### 20. [🟡 LOW] Checksum-seed catch is broad (ENOENT + parse + I/O) but comment claims only 'no log yet' → parse/I/O error logged nowhere
`services/agent-host/src/session/fileStore.ts:61`

**Problem.** The seed catch covers ENOENT, JSON.parse on a corrupt/torn line, and read I/O, but the comment 'no log yet -> empty seed' claims only the ENOENT case. (The reviewer's stronger claim — that reseeding to EMPTY_CHECKSUM defeats tamper detection — does not hold: the checksum is a UI gap/resync mechanism, a wrong seed makes the emitted prevChecksum mismatch the client's and fires the self-heal refetch, and the real corrupt-line read path in readEvents has no catch so it 500s.) The genuine residual is a server-side observability gap: a true parse/I/O error here is logged nowhere.

**Fix.** Treat ENOENT as the silent empty seed; log+rethrow (or emit an integrity-degraded signal) on parse/I/O errors so operators see a corrupt persisted log, even though clients already detect the divergence.

### 21. [🟡 LOW] Provider factory exception logged and skipped → a broken built-in provider is silently absent
`services/broker/broker/core/registry.py:74`

**Problem.** A provider whose factory raises is logged (logger.exception) and skipped via continue, so the broker boots without it. For external/optional entry-point providers this degrade-don't-break is intentional and reasonable. The reviewer's specific aws scenario mostly doesn't fire at factory time (PermissionStore/IamProvisioner construction is lazy; a bad accounts file is swallowed upstream → inert 503; real DB-connect failures happen in store.init() inside on_startup, which IS awaited and crashes loudly). Residual smell only: the broad except covers built-in providers too, and /health is hardcoded {'status':'ok'}, so a broken built-in factory is discoverable only via logs.

**Fix.** Keep best-effort skip for optional/external providers, but for built-in providers fail startup (or expose a degraded-providers health endpoint listing which factories failed) so a broken core provider is loud rather than silently absent.

### 22. [🟡 LOW] safeParsePrices catches malformed pricing JSON → cost metrics silently disabled despite explicit config
`services/agent-host/src/index.ts:143`

**Problem.** parsePriceTable is deliberately documented to throw on malformed JSON so misconfiguration is visible; safeParsePrices catches it and returns {}, so a malformed AGENT_PRICING_JSON/FILE disables all cost metrics (computeCost yields priced:false for every model) and cost dashboards go empty. Milder than a hard bug: it emits console.warn, tokens are still counted, the metrics subsystem is off unless OTEL_METRICS_ENABLED=1, and {} is the documented no-pricing default. The smell is a config error in the observability path surfaced only at warn with no metric-side degraded signal.

**Fix.** Log at error level and surface a degraded-state gauge (e.g. pricing_invalid) so the broken config is observable rather than just a warn line.

### 23. [🟡 LOW] readPricing swallows unreadable AGENT_PRICING_FILE → cost metrics omitted (already warn-logged)
`services/agent-host/src/index.ts:130`

**Problem.** The bare catch on readFileSync returns '' when an explicitly-configured AGENT_PRICING_FILE is unreadable (wrong path, ConfigMap unmounted, perms), disabling cost derivation. Mildest of the pricing trio: it ALREADY logs console.warn with the exact path and reason, tokens are still emitted, and priced:false avoids a misleading $0. Residual smell: it logs at warn (not error) for a file the operator explicitly configured, uses an unnarrowed bare catch, and emits no health signal.

**Fix.** Bump to console.error and/or expose a one-shot 'pricing_unavailable' metric/health flag when AGENT_PRICING_FILE was set but unreadable; optionally narrow the catch. Consider failing fast since the file was explicitly requested.

### 24. [🟡 LOW] loadLinks returns [] on any throw → linked-resources panel silently shows nothing (no log)
`ui/src/client.ts:84`

**Problem.** A failed/corrupt /links fetch is indistinguishable from a conversation with no linked resources. The sole caller polls every 10s so a transient failure self-heals on the next tick and the cosmetic, non-persistence panel just renders null until then; no source-of-truth data is lost. The only real defect is observability: the bare catch has no console.warn, so a PERSISTENT 500 / malformed JSON (vs a transient outage) is invisible to anyone debugging why links don't appear.

**Fix.** Add console.warn(err) in the catch (and optionally a degraded indicator); leave the [] fallback.

### 25. [🟡 LOW] requestPermission returns 'cancelled' when no handler registered → missing-handler bug looks like user cancel
`services/agent-host/src/acp/client.ts:131`

**Problem.** If permissionHandler is undefined, requestPermission returns outcome 'cancelled' with no log, masquerading a wiring/lifecycle misconfiguration as a real user cancellation. In this codebase the handler is registered synchronously in bridge.start() before any prompt(), so the misconfig is not currently reachable, and deny-by-default is a safe ACP response. Genuine but mild observability smell: a future refactor/fake driving a prompt without a handler would have an invisible wiring bug, and the module already imports debug/debugError but doesn't use it here.

**Fix.** Log (debug/debugError) when permissionHandler is undefined so a missing-handler misconfiguration is observable rather than silently masquerading as a user cancellation.

### 26. [🟡 LOW] loadState resets to freshState() on corrupt localStorage with no log
`ui/src/sessions.ts:76`

**Problem.** The catch wraps JSON.parse/validation of an optimistic localStorage cache (the file's own comment calls it a cache, not truth). On corruption or a botched STORAGE_KEY v1→v2 migration it resets to freshState() with zero signal. Impact is bounded: mergeFromServer re-populates the sidebar from the server on every poll, so server-backed conversations are restored a moment later, and the only unrecoverable items (local-only pristine 'New chat' placeholders) are deliberately dropped by the merge anyway. Residual: a recurring corruption / bad migration is invisible.

**Fix.** Add console.warn(e) in the catch before returning freshState() so a recurring bad migration is observable; the degrade-to-fresh behavior is correct and should stay.

### 27. [🟡 LOW] HTTPError body-parse catch drops error detail (status preserved) — minor; real misdirection lives in caller
`services/broker/broker/aws/cli.py:71`

**Problem.** The inner `except Exception: return e.code, {}` only fires when an HTTPError body is non-JSON/unreadable, and it ALWAYS preserves e.code, so the operative status signal is never lost. The misdirection the reviewer described (a 5xx/403 collapsed into the same 'not granted' message as a genuine no-active-grant) is actually a property of credentials_main's own logic (it discards the body for any non-200 and falls through to _not_granted_message), not this catch. What the catch itself loses is only the error-detail body, so a parse failure prints 'request failed (<status>): {}' — status shown, detail dropped.

**Fix.** Log/print the raw error body to stderr when JSON parse fails so the detail isn't lost. Separately (the larger issue) have credentials_main distinguish a 5xx/auth error from a genuine 200-with-no-active-grant rather than collapsing both into _not_granted_message.
