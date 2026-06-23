# Testing strategy — integration-focused TDD

> Status: **Tests stage** (specs + scaffolding first; implementation makes them
> pass). Tests are written **red** against the Design-stage interfaces.

The risk in this project is **seam integration**, not unit logic. So tests are
integration-weighted, in three tiers, **cluster-agnostic** (any Kubernetes;
local k3s path provided first; k3s is the default).

## Tiers

### Tier 1 — Contract (fast, no cluster, no network)
Pure-process tests of each seam against fakes. Deterministic, run in CI on every
push.

- `agent-host/test/contract/bridge.spec.ts` — ACP→AG-UI mapping (the §4c table).
  Drives a **fake ACP agent** emitting scripted `session/update`s; asserts the
  exact AG-UI event sequence.
- `agent-host/test/contract/exec.spec.ts` — `ExecBackend` against a **fake
  agent-sandbox API**; asserts ACP `terminal/*`/`fs/*` map to `/execute`,
  `/upload`, `/download`.
- `agent-host/test/contract/session.spec.ts` — `SessionManager` lifecycle with a
  **fake provisioner + in-memory store**: start, prompt, suspend, revive (replay
  log), end.

### Tier 2 — Cluster (real Kubernetes, no real agent)
Provisioning + lifecycle against a live cluster with the agent-sandbox
controller installed. Uses the **fake ACP agent** image so it's deterministic
and key-free. Gated behind `RUN_CLUSTER_TESTS=1`.

- `test/cluster/provision.spec.ts` — cold `Sandbox` per conversation: SA
  `sandbox-{id}` created, two/one PVCs bound, pod reaches Ready, `:8888`
  reachable.
- `test/cluster/suspend-resume.spec.ts` — suspend drops Pod & keeps PVCs;
  write a file → suspend → resume → file still there (workspace persistence).
- `test/cluster/warmpool.spec.ts` — generic warm-pool claim is fast (latency
  budget) vs. cold start.
- `test/cluster/broker.spec.ts` — (post-PoC) pod authenticates to the broker via
  projected SA token; a credentialed action succeeds; wrong audience is rejected.

### Tier 3 — E2E (UI through the whole stack, Playwright)
Browser-driven through assistant-ui against a deployed agent-host. Mostly fake
ACP agent; **one** scenario uses real `goose acp` (`RUN_REAL_GOOSE=1`, needs a
model key) to prove the actual binary integrates.

- `test/e2e/conversation.spec.ts` — provision → prompt → AG-UI events render
  live; multi-turn; tool-permission approval.
- `test/e2e/revive.spec.ts` — suspend from UI → revive → history + workspace
  intact.
- `test/e2e/sessions.spec.ts` — list/view existing sessions and their logs.
- `test/e2e/real-goose.spec.ts` — one real-Goose happy path.

## Shared test doubles

- **Fake ACP agent** (`test/fakes/fake-acp-agent/`) — a tiny stdio JSON-RPC
  server honoring the ACP *agent* side: `initialize`, `session/new`,
  `session/prompt`; emits a **scripted** sequence of `session/update`
  notifications and exercises client methods (`terminal/*`, `fs/*`,
  `session/request_permission`) on cue. Packaged as a Nix app + a sandbox image
  variant so cluster tests can run it in-pod.
- **Fake agent-sandbox API** (`test/fakes/fake-sandbox-api.ts`) — in-memory
  server implementing `/execute`, `/upload`, `/download`, `/list`, `/exists`.
- **Cluster fixture** (`test/support/cluster.ts`) — provider-agnostic: targets
  the current `kubectl` context; can bootstrap kind/minikube/k3d; installs the
  agent-sandbox controller + our CRs; tears down. Selected via `CLUSTER_PROVIDER`
  (`existing` | `kind` | `minikube` | `k3d`).

## Running

```bash
# Tier 1 (always)
npm -w agent-host test

# Tier 2 (needs a cluster)
RUN_CLUSTER_TESTS=1 CLUSTER_PROVIDER=k3s npm run test:cluster

# Tier 3 (needs a deployed stack)
npm run test:e2e
RUN_REAL_GOOSE=1 npm run test:e2e -- real-goose
```

## TDD status

All tests are authored **red** against `docs/DESIGN.md` interfaces. Implementation
proceeds seam-by-seam (bridge → exec → session → provisioner → UI) turning tiers
green bottom-up.
