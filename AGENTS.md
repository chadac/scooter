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

### Fixing a flake: label the PR so CI proves it

A PR that fixes a flaky test declares the test in its **description** and opts in
with a **label**. Without the label nothing extra runs; without the description
line the check fails loudly rather than passing on zero tests.

```
flake-test: THREE messages sent mid-run       # playwright -g pattern (required)
flake-specs: test/e2e/queue-durability.spec.ts test/e2e/ui-state-consistency.spec.ts
```

`flake-specs:` is optional — give it when the flake only reproduces under
cross-spec contention, and CI runs those files together instead of the lone `-g`
match.

Both focused jobs report into **one shared PR comment**, a section each (fast /
full), updated in place on every re-run — so a PR carrying both labels shows the
two verdicts together rather than two comments competing to be "the" answer. Each
section names the test and its verdict — "no reproduction in 20 repetitions", or "still
reproduces, 3 of 20", with the failure output. Read the comment, not the green
check: under `flake-specs:` the job runs whole spec files, so its exit status can
be red for an unrelated test, and green while the flaky one never ran.

That last case is now a **failure**, not a pass: `flake-test:` must match a test
that actually executes (it is matched case-insensitively against
`file › describe › test`, like `-g`) — including on the contention path, where it
selects nothing but still decides the verdict. A check that ran zero repetitions
of the flake proves nothing and must not report green.

**The control run.** When a focused job's own repetitions come back clean, it
re-runs the same test with the same budget on the PR's **base commit** and
reports both rates. "0 failures in 20 runs" is unfalsifiable alone — a test that
fires once in 200 runs gives exactly that on a branch that fixed nothing. So the
comment distinguishes:

- the flake fires on the base and not here, **often enough** that luck is an
  unlikely explanation — the strongest evidence this job can produce;
- it fires on the base only rarely (say 2/20, leaving ~12% odds of 20 clean runs
  by chance) — reported as a **weak control**, not as a fix;
- it fires on **neither** — the run had no power at all; raise the repetitions,
  add `flake-specs:`, or move to the full target. (On the full target there is
  nowhere further to move: the repeat budget is the only knob left.)

The control costs roughly a second run of the job, so it is skipped when the PR's
own run already reproduced the flake (the answer is in already).

The full comment also carries an **`On main recently`** row — the spec's record
across the last few nightly `e2e-full` runs, read from their uploaded reports.
That is prior evidence, not a control: a nightly runs the whole suite, so its
rate includes contention the targeted run does not have, and scoring a quiet
clean run against it would overstate the result. Read it for one thing in
particular — *the spec is failing on `main` but the control reproduced nothing*
means the control did not recreate the conditions the flake needs, so the clean
run says nothing about a fix.

**Both** focused jobs run one. The full-target control redeploys the base's whole
platform — it tears the PR's k3d cluster down and brings the base's up in its
place, rather than running the base's specs against the PR's deployment. The
cheap version is only a control when the fix happens to be test-side, and whether
it is test-side is exactly what nobody knows up front. The k3d registry survives
the teardown and its tags are content-addressed, so every image the base shares
with the PR skips the push — for a test-only fix, all of them.

| Label | Job | Runs against |
|---|---|---|
| `flake-check` | flake focus (targeted ×20) | **fast** — fake stack |
| `e2e-full-flake-check` | flake focus full (k3d, targeted ×5) | **full** — a real k3d cluster |
| `e2e-full` | e2e full (k3d) | the whole full suite, once |

Both full-target jobs run on the **self-hosted fleet**, the same runners as the
nightly. A control on different hardware is being asked to reproduce a
contention flake in conditions it was never seen in.

To run one test against the full target — locally or in CI — use
`just e2e-full-run` (the local `just e2e-full` brings up a port-forward and then
calls it). Do not open-code `npx playwright test --project=full`: the recipe
holds the `--workers` guard and the `E2E_TARGET`/`E2E_CLUSTER_URL` contract, and
a run with workers measures nothing.

### When is a flake fix DONE?

**Read the heading of the job's comment section, not the check's colour.** The
check is red whenever anything in a contention run failed, and green whenever
the command exited 0 — neither of which is a verdict on your flake. The report
renders exactly one of these, and only the first means done:

| Comment heading | Means | Done? |
|---|---|---|
| `✅ … fixed: it fires on the base, not here` | Fires on the base often enough that a clean run here is unlikely by luck (≤5%) | **YES** |
| `✅ … clean here, but the control is weak (n/m on the base)` | Base barely fired; luck explains it nearly as well as a fix | No — raise the budget |
| `⚠️ … clean, but the control did not reproduce either` | Fired on neither. The experiment had **no power** | No — proves nothing |
| `✅ … no reproduction in n repetitions` | No control ran at all | No — unfalsifiable alone |
| `❌ … the flake STILL reproduces` | Fails here | No |
| `⚠️ … the targeted test never ran` | `flake-test:` matched nothing that executed; the gate fails the job | No — fix the pattern |

A green check with any heading other than the first is **not** evidence of a
fix. "0 failures in n runs" cannot distinguish a fix from a flake that simply
did not fire; that is the whole reason the control exists.

Two more rules that catch most mistakes:

- **Never claim a nightly-`e2e-full` flake is fixed off a green `flake-check`.**
  The fast stack has no sandbox pods, so it cannot produce the cold boots, CPU
  saturation or provisioning contention those flakes live in. Green there shows
  no *regression*. Use `e2e-full-flake-check` for the evidence.
- **A heading is not the last word — read the `On main recently` row under it.**
  If the spec is still failing nightly on `main` while the control reproduced
  nothing, the report says so in bold, and that overrides a clean-looking
  heading: the control did not recreate the conditions. If the spec passed every
  nightly in the window, there is no live reproduction to fix — check
  `flake-test:` names the test you mean.
- **For `e2e-full` itself, read the baseline diff, not the failure count.** Only
  "failed here and passed in every baseline run" is attributable to the change.
  A spec red in 1/5 baseline runs is a flake to take to
  `e2e-full-flake-check`, not a regression.

### Reading the `e2e-full` verdict

**The label is enough — `e2e-full` is NOT path-gated.** It once was, and a
labelled UI-only PR was silently skipped as a result; #646 removed the filter
because it covered the specs and the cluster plumbing but not the product code
under test. All three label-gated jobs now trigger on the label alone. (This
section said the opposite until #697. If you are reasoning about whether a label
"took", read the `if:` in `.github/workflows/ci.yml` rather than trusting prose —
including this prose.)

When it runs, it posts a sticky comment diffing this run against a **window of
the last few full runs on `main`** — new failures / still failing / newly passing.
Read the diff, not the red check. The full suite is flaky night to night (three
consecutive nightlies failed 13, 7 and 12 specs with only partial overlap), so the
failure *count* carries almost no information; "failed here and passed in every
baseline run" is the part attributable to your change. A spec listed as "red in 1/5
baseline runs" is a flake to take to `e2e-full-flake-check`, not a regression.

Two cases where the comment deliberately refuses to give a verdict: no baseline was
retained, and a shard died before writing its report (its specs are then absent from
the merge, which a set difference would happily render as a page of green "newly
passing" rows nobody verified).

**Which one you need depends on where the flake was seen.** A flake reported by
the nightly `e2e-full` usually cannot reproduce on the fast target at all: the
fast stack has no sandbox pods, so it has no cold boots, no node CPU saturation,
and no contention for provisioning — which is where those flakes live. A green
`flake-check` on such a PR shows no *regression*; it is not evidence the flake is
fixed. Use `e2e-full-flake-check` for those.

It is the slowest of the three, but not as slow as this file used to claim.
Measured end-to-end on #697 — on `ubuntu-latest`, which is no longer where this
job runs: #703 moved it to the self-hosted fleet, so treat the shape as right
and the absolute numbers as indicative. The one post-move data point agrees on
the part that dominates (bring-up, 217s both times).

| | |
|---|--:|
| k3d + the full platform rollout | 3m37s |
| 5 targeted repetitions | 3m18s |
| the control (its own rollout + 5 more) | 5m25s |
| **total** | **13m08s** |

So budget **~13 min**, not 25. The control is cheaper than the PR's own half
because its bring-up reuses the already-populated registry — 117s against 217s,
with all eight image pushes skipped on a content-tag HEAD.

That budget is for a **targeted-only** run. Adding `flake-specs:` buys
contention by running those specs alongside, and it is the dominant cost: job
111985657548 spent 947s in the contention phase against 217s of bring-up, ~21
min total. Add it when the flake needs contention to fire, not by default.

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
| `skills/` | Markdown agent skills that document the PLATFORM (`scooter-intro`, `scooter-env`, `agent-tools`, …) — a skill documenting a contrib lives in that contrib, gated on it |
| `test/`, `nixos-tests/` | cluster-integration + e2e fixtures/fakes; NixOS VM tests for the sandbox image |
| `services/agent-host/test/` | unit (contract) tests |
| `docs/` | user-facing mkdocs site; the full `DESIGN.md`/`TESTING.md` are kept locally, outside the repo |

## Reference

- Upstream agent-sandbox source was inspected at commit `52d1f97` (CRDs,
  controller suspend/PVC behavior, runtime contract, client SDKs).
- The skills, broker, and webhooks patterns were originally adapted from the
  sibling `openhands-nix` project.
