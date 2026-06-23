# CLAUDE.md — kubenix-agent-sandbox

Guidance for working in this repo. Read `docs/DESIGN.md` and `docs/TESTING.md`
before making changes.

## What this is

A Nix-powered agent platform layered over the Kubernetes
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller.
agent-sandbox provides the execution **body** (pods, warm pools,
suspend/resume); this repo adds the **brain** (an off-the-shelf ACP agent — Goose
— run *outside* the sandbox) and a **conversation UI** (AG-UI + assistant-ui).
The agent drives the sandbox via the agent-sandbox API; nothing is an in-pod
agent. See `docs/DESIGN.md` for the full architecture and the reasoning behind
the agent-outside inversion, the two-PVC persistence model, and broker auth.

## Status

This is built via a staged PoC process: Research → Design → Tests →
**Implementation**. The agent-host TypeScript is being implemented seam-by-seam
and **Tier 1 contract tests are green (12/12)**. Done so far: ACP↔AG-UI bridge,
ExecBackend (K8s exec API), SessionManager, real ACP client (spawns `goose
acp`), K8s SandboxProvisioner, AG-UI SSE server, file-backed ConversationStore,
and index.ts wiring. Still to do: the UI, the local cluster fixture
(`test/support/cluster-up.sh`, k3s), and turning Tier 2/3 green. Nix image +
kubenix modules are still partly sketched. See `docs/DESIGN.md`.

## ALWAYS run the tests

`just` is the task runner. **Run the suite to confirm changes work — do not
assume.** The tests are the spec; implementation is done seam-by-seam to turn
them green (bridge → exec → session → provisioner → UI).

```bash
just test-quick     # Tier 1 contract tests — fast, no cluster. Run constantly.
just test           # FULL suite: Tier 1 + Tier 2 (cluster) + Tier 3 (E2E).
just ci             # What CI runs: flake check + typecheck + Tier 1.
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
- After changes touching provisioning (`modules/`, `pkgs/sandbox-image/`,
  session/provisioner code), run `just test-cluster`.
- After UI or end-to-end flow changes, run `just test-e2e`.
- Before declaring a milestone done, run the full `just test` and report the
  real result — including failures and skips. Never claim green without running.

## Test tiers (see docs/TESTING.md)

- **Tier 1 — contract** (`agent-host/test/contract/`): the seams against fakes
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
| `flake.nix` | sandbox image, agent-host, ui, agent (goose) |
| `agent-host/` | TS: ACP⇄AG-UI bridge, session manager, SDK exec backend |
| `pkgs/sandbox-image/` | generic Nix sandbox image (no in-pod server; exec via K8s API) |
| `modules/` | kubenix: per-conversation Sandbox, agent-host, warm pool |
| `ui/` | assistant-ui frontend + AG-UI client library |
| `test/` | Tier 2 cluster + Tier 3 e2e + fixtures/fakes |
| `agent-host/test/` | Tier 1 contract tests |
| `docs/` | `DESIGN.md`, `TESTING.md` |

## Reference

- Upstream agent-sandbox source was inspected at commit `52d1f97` (CRDs,
  controller suspend/PVC behavior, runtime contract, client SDKs).
- Sibling repo `../openhands-nix` is the source of the skills, broker, and
  webhooks patterns being re-targeted here.
