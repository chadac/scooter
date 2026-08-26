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
just test-quick     # unit tests — contract seams against fakes; no cluster. Run constantly.
just test           # FULL suite: unit + cluster integration + e2e fast.
just ci             # What CI runs: flake + manifest/lockfile/hash checks + lint + unit.
```

Per-suite:

```bash
just test-unit       # unit             (no cluster, no network)
just test-cluster    # cluster integration (vitest on real k8s; auto-starts one)
just test-e2e        # e2e fast         (Playwright through the UI; fake agent)
just e2e-full        # e2e full         (same specs against a real k3d cluster)
just test-e2e-real   # e2e real-agent   (one scenario with REAL goose; needs a model key)
```

While iterating, run a TARGETED subset instead of the ~25-minute full suite:

```bash
just e2e test/e2e/stop-run.spec.ts      # one file, ~45s
just e2e test/e2e/a.spec.ts test/e2e/b.spec.ts
just e2e -g "queueing keeps thread"     # one test by title
```

Against a REAL cluster (the `cluster` Playwright project — the browser/real-server
seam that neither the e2e suite nor `test/cluster/` covers):

```bash
just cluster-platform     # build + import images, apply the platform (minutes)
just e2e-cluster          # run the cluster-project specs against it
just e2e-cluster -g "..."  # …or a subset
just cluster-redeploy     # rebuild ONLY what changed, restart it
just cluster-down         # tear it down
```

`e2e-cluster` **refuses to run against a stale cluster**: it fingerprints each
platform image by its nix derivation path (content-addressed, ~6s, no build) and
compares against what was deployed. A cluster running old images reports green while
testing code you did not write — the same trap as a reused dev server serving a stale
build. It names what changed and points at `cluster-redeploy`; `E2E_ALLOW_STALE=1`
overrides when you mean it.

**Never pass `--workers`.** The suite shares ONE agent-host and its conversation
state, so parallel workers interleave: the run reports green while testing nothing
coherent. `playwright.config.ts` pins `workers: 1` for this reason and a CLI flag
overrides it silently — `just e2e` rejects the flag outright.

Rules of thumb:
- After **any** change to `agent-host/`, run `just test-unit` before moving on.
- After changes touching provisioning (`modules/`, `pkgs/sandbox-os/`,
  session/provisioner code), run `just test-cluster`.
- After UI or end-to-end flow changes, run `just test-e2e`. Iterate with
  `just e2e <spec>`, but a green subset is **not** evidence the branch is green —
  the full suite or CI decides that.
- Before declaring a milestone done, run the full `just test` and report the
  real result — including failures and skips. Never claim green without running.

## Proving a bugfix: `@proves` tests

A bugfix PR should include at least one test whose title ends with **`@proves`** —
a claim that this test fails without the fix. CI (the `fails-first` job) and
`just proves` verify the claim mechanically: the marked tests added in your branch
are run on the PR's base with only the test files grafted over, and every one must
FAIL there (and pass on your branch). A `@proves` test that passes on base turns
the check red — it has no discriminating power, which is exactly the bug-shaped
hole this closes.

- Put `@proves` on the same line as `it(`/`test(`, in a plain quoted title
  (no template strings).
- Don't mark refactor/characterization tests — only tests that demonstrate the
  defect being fixed. Unmarked tests are never checked.
- A base-side failure that never reaches the assertion (the test imports API the
  PR introduces) is accepted but reported as `load-error` — a weaker proof.
  Prefer tests that compile on base and fail on the assertion when you can.
- Run `just proves` locally before pushing (`just proves origin/<base>` when the
  PR targets a stacked branch).

## Test suites (see docs/TESTING.md)

- **unit** (`services/agent-host/test/contract/` and friends, vitest): the seams
  against fakes (fake ACP agent, fake sandbox API). The `bridge.spec.ts` ACP→AG-UI
  mapping is the highest-value test. Deterministic.
- **cluster integration** (`test/cluster/`, vitest): provisioning, suspend/resume PVC
  persistence, warm-pool latency, broker auth — on a real cluster with the
  **fake ACP agent** image. Gated `RUN_CLUSTER_TESTS=1`. Cluster-agnostic
  (`CLUSTER_PROVIDER=existing|k3s|kind|minikube|k3d`; default `k3s`).
- **e2e fast** (`test/e2e/`, Playwright, the default project): the browser, the UI,
  and agent-host are all REAL; the agent and the sandbox/cluster are faked. Fast and
  deterministic. One real-Goose spec (`RUN_REAL_GOOSE=1`).
- **e2e full** (same specs, `--project=full` via `E2E_TARGET=full`): against a real
  k3d cluster (or a live deployment). The only suite where the browser meets the real
  server. NOT a superset of fast — fault-proxy specs run fast only. Gate specs with
  `fastOnly(reason)` / `fullOnly(reason)` from `test/e2e/target.ts`.

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
| `test/`, `nixos-tests/` | cluster-integration + e2e fixtures/fakes; NixOS VM tests for the sandbox image |
| `services/agent-host/test/` | unit (contract) tests |
| `docs/` | user-facing mkdocs site; the full `DESIGN.md`/`TESTING.md` are kept locally, outside the repo |

## Reference

- Upstream agent-sandbox source was inspected at commit `52d1f97` (CRDs,
  controller suspend/PVC behavior, runtime contract, client SDKs).
- The skills, broker, and webhooks patterns were originally adapted from the
  sibling `openhands-nix` project.
