# AGENTS.md — Scooter

Guidance for working in this repo. (The full design docs — e.g. `DESIGN.md`,
`TESTING.md`, `DEV_ENVIRONMENT_DESIGN.md` — are kept locally, outside the repo;
some `see docs/…` pointers in the code refer to that local copy. The committed
`docs/` tree is the user-facing mkdocs site.)

## What this is

A Nix-powered agent platform layered over the Kubernetes
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller.
agent-sandbox provides the execution **body** (pods, warm pools,
suspend/resume); Scooter adds the **brain** (an off-the-shelf ACP agent — Goose
— run *outside* the sandbox) and a **conversation UI** (AG-UI + assistant-ui).
The agent drives the sandbox via the agent-sandbox API; nothing is an in-pod
agent. See `docs/DESIGN.md` for the full architecture and the reasoning behind
the agent-outside inversion, the two-PVC persistence model, and broker auth.

## Status

This project is **implemented and running in production-shaped deployments**.
Multi-replica agent-hosts with controller-assigned conversations, suspend/resume
with history restore, bring-your-own-Claude (device-key auth, concurrent
conversations), a provider-aware model catalog, webhooks/scheduler/broker
integrations, and a working UI are all live. Development continues via iterative
improvements and new features.

## Working in this repository

**ALWAYS work inside the nix dev shell.** This repo uses `flake.nix` to provide a complete dev environment with all dependencies properly configured (playwright browsers, correct node/npm versions, test tools, etc.). The shell sets up environment variables like `PW_CHROME` that point to nix-provided binaries, ensuring playwright tests use the correct browser builds.

To enter the dev shell:

```bash
nix develop --no-sandbox  # or use direnv (already configured via .envrc)
```

Once in the shell, all test commands, builds, and playwright runs will work correctly. Running tests outside the dev shell will fail with missing dependencies or version mismatches.

## ALWAYS run the tests

`just` is the task runner. **Run the suite to confirm changes work — do not
assume.** The tests are the spec; implementation is done seam-by-seam to turn
them green (bridge → exec → session → provisioner → UI).

```bash
just test-quick     # Tier 1 contract tests — fast, no cluster. Run constantly.
just test           # FULL suite: Tier 1 + Tier 2 (cluster) + Tier 3 (E2E).
just ci             # What CI runs: flake + manifest/lockfile/hash checks + lint + Tier 1.
```

Per-tier:

```bash
just test-unit       # Tier 1  (no cluster, no network)
just test-cluster    # Tier 2  (real k8s; auto-starts a local cluster)
just test-e2e        # Tier 3  (Playwright through the UI; fake ACP agent)
just test-e2e-real   # Tier 3  (one scenario with REAL goose; needs a model key)
```

Rules of thumb:
- After **any** change to `agent-host/`, run `just test-unit` before moving on.
- After changes touching provisioning (`modules/`, `pkgs/sandbox-os/`,
  session/provisioner code), run `just test-cluster`.
- After UI or end-to-end flow changes, run `just test-e2e`.
- Before declaring a milestone done, run the full `just test` and report the
  real result — including failures and skips. Never claim green without running.

## Test tiers (see docs/TESTING.md)

- **Tier 1 — contract** (`services/agent-host/test/contract/`): the seams against fakes
  (fake ACP agent, fake sandbox API). The `bridge.spec.ts` ACP→AG-UI mapping is
  the highest-value test. Deterministic.
- **Tier 2 — cluster** (`test/cluster/`): provisioning, suspend/resume PVC
  persistence, warm-pool latency, broker auth — on a real cluster with the
  **fake ACP agent** image. Gated `RUN_CLUSTER_TESTS=1`. Cluster-agnostic
  (`CLUSTER_PROVIDER=existing|k3s|kind|minikube|k3d`; default `k3s`).
- **Tier 3 — E2E** (`test/e2e/`, Playwright): the UI through the whole stack.
  Mostly fake agent; one real-Goose spec (`RUN_REAL_GOOSE=1`).

## Conventions

- **Cluster-agnostic:** never hardcode minikube. Go through
  `test/support/cluster.ts` / the `CLUSTER_PROVIDER` env var.
- **The agent runs outside the pod.** If you find yourself baking Goose or the
  agent-host into the sandbox image, stop — that's the inverted (wrong) model.
- **One cold `Sandbox` per conversation** (not a warm-pool claim): required for
  the per-conversation ServiceAccount + persistent PVCs. Warm pools are only for
  generic capacity.
- **Suspend, don't delete.** The `Sandbox` object is the durable conversation
  handle.
- Keep tests **red-first**: add/adjust the failing test before implementing.

## Layout

| Path | What |
|------|------|
| `flake.nix` | Nix entry: sandbox image, agent-host, ui, broker, webhooks, scheduler, agent (goose), platform manifests |
| `services/agent-host/` | TS: ACP⇄AG-UI bridge, session manager, K8s-exec backend, web-service proxy, MCP agent tools, auth |
| `services/broker/` | Python/FastAPI credential broker + provider modules (GitHub, GitLab, Jira, Slack, AWS, Datadog) |
| `services/webhooks/`, `services/scheduler/` | Python/FastAPI: spawn conversations from provider threads / fire cron-scheduled tasks |
| `services/claude-sdk-provider/` | Claude Agent SDK provider (an alternative brain to goose) |
| `pkgs/sandbox-os/` | the NixOS systemd-PID-1 dev sandbox image (exec via K8s API) |
| `pkgs/broker-tools/` | broker CLIs (`agent-broker` / `git-credential-broker` / `scooter-aws*`), prebuilt into the sandbox |
| `modules/` | kubenix: per-conversation cold `Sandbox` (SA + 2 PVCs), agent-host, broker, webhooks, scheduler, warm pool |
| `ui/` | assistant-ui frontend + AG-UI client library |
| `skills/` | Markdown agent skills (`scooter-intro`, `scooter-env`, `agent-tools`, `scooter-aws`, …) |
| `test/`, `nixos-tests/` | Tier 2 cluster + Tier 3 e2e fixtures/fakes; NixOS VM tests for the sandbox image |
| `services/agent-host/test/` | Tier 1 contract tests |
| `docs/` | user-facing mkdocs site; the full `DESIGN.md`/`TESTING.md` are kept locally, outside the repo |

## Reference

- Upstream agent-sandbox source was inspected at commit `52d1f97` (CRDs,
  controller suspend/PVC behavior, runtime contract, client SDKs).
- The skills, broker, and webhooks patterns were originally adapted from the
  sibling `openhands-nix` project.
