# kubenix-agent-sandbox — Design

> Status: **Design stage** (boilerplate / interfaces; no implementation yet).
> Follows the PoC process: Research → **Design** → Tests → Review → Implementation.

## 1. Summary

A Nix-powered agent platform layered over the upstream Kubernetes
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller.

agent-sandbox provides a **fleet of pre-warmed, generic, isolated execution
environments** (pods) — body-for-rent — with lifecycle, warm pools,
suspend/resume, a per-pod runtime contract (`/execute` + files on :8888), a
router, and Go/Python client SDKs. It does **not** provide an agent loop, a
conversation model, or a UI.

This project supplies those, using off-the-shelf standards:

- **Brain (agent):** an off-the-shelf **ACP** agent — first target **Goose**
  (`goose acp`), already in nixpkgs. We do not write an agent loop.
- **UI seam:** the **AG-UI** protocol, consumed natively by **assistant-ui**.
- **Glue:** an **agent-host** service that runs the agent **outside** the
  sandbox, bridges ACP ⇄ AG-UI, and services the agent's tool actions by
  calling the **agent-sandbox API** against the session's pod.
- **Nix:** a *generic* sandbox image — agent-sandbox runtime contract + Nix
  (overlay /nix store, lazy shims, skills available to commands).
- **kubenix:** modules generating `SandboxTemplate` / `SandboxWarmPool` /
  `Sandbox`.

Reused later (post-PoC) from `openhands-nix`: **broker** (credential injection)
and **webhooks** (spawn-from-conversation).

## 2. The #1/#2/#3 framing

OpenHands bundled three concerns; agent-sandbox replaces only #3.

| # | Concern | Provided by |
|---|---------|-------------|
| 1 | Agent runtime (LLM loop) | **off-the-shelf ACP agent** (Goose), run in the agent-host |
| 2 | Session/conversation manager (history, events, status) | **agent-host**, over **AG-UI**, persisted to the conversation PVC |
| 3 | Execution environment (pod, lifecycle, warm pools, suspend/resume) | **agent-sandbox** (upstream) |

## 3. Architecture — agent OUTSIDE the sandbox

```
 browser (assistant-ui, native AG-UI runtime)
        │  AG-UI events  (SSE/WS) — direct from agent-host
        ▼
 agent-host service  (OUTSIDE the sandbox)
   ├─ one `goose acp` process per conversation (ACP/JSON-RPC over stdio)
   ├─ ACP ⇄ AG-UI bridge                              → browser
   ├─ ACP client methods (terminal/*, fs/*) ──────────┐
   └─ conversation-state PVC (Goose session + log)     │  (the agent's actions)
                                                       ▼
                              agent-sandbox SDK  ──►  Sandbox pod (the body)
                                (/execute, /upload,       ├─ :8888 runtime contract
                                 /download, files)        ├─ Nix: overlay store + skills
                                                          └─ workspace PVC
        ▲
 agent-sandbox controller
   (Sandbox CRD, warm pools, suspend = drop Pod / keep PVCs, router)
```

**Why outside:** agent-sandbox is designed for the agent to live elsewhere and
drive the pod remotely (its SDK/router/contract all assume this). Running the
agent in-pod fought that and made pods heavyweight/task-shaped, breaking warm
pools. Outside-the-pod restores generic interchangeable pods, lets the AG-UI
stream reach the browser directly, and decouples brain lifecycle from body
lifecycle.

**The ACP↔agent-sandbox snap:** in ACP the agent calls *client methods*
(`terminal/*`, `fs/*`) on its host to act. The agent-host services those by
calling the agent-sandbox API into the session's pod. ACP ("agent asks host to
run things") + agent-sandbox ("host runs things in a remote pod") compose
exactly.

## 4. Protocol seams

### 4a. ACP (agent-host ⇄ Goose) — JSON-RPC 2.0 over stdio
- Host → agent: `initialize`, `session/new`, `session/prompt`, `session/cancel`.
- Agent → host (`session/update`): `agent_message_chunk`, `tool_call`,
  `tool_call_update`, `plan`, thoughts.
- Agent → host client methods: `session/request_permission`, `fs/read_text_file`,
  `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release`.
  **Serviced via the agent-sandbox SDK.**

### 4b. AG-UI (agent-host ⇄ browser) — streaming events (SSE or WS, TBD)
Lifecycle, text, tool-call, reasoning, state events (see §4c mapping).

### 4c. ACP → AG-UI mapping (≈ 1:1)

| ACP | AG-UI |
|-----|-------|
| `session/prompt` accepted | `RunStarted` |
| `agent_message_chunk` | `TextMessageStart` → `Content`(δ) → `End` |
| `tool_call` | `ToolCallStart` + `ToolCallArgs` |
| `tool_call_update` / terminal result | `ToolCallResult` |
| `plan` / thoughts | `Reasoning*` |
| `session/request_permission` | tool-call awaiting inline approval → reply over ACP |
| turn complete | `RunFinished` |
| agent error | `RunError` |

### 4d. agent-sandbox runtime contract (agent-host ⇄ pod, via SDK/router)
`POST /execute`, `POST /upload`, `GET /download/{p}`, `GET /list/{p}`,
`GET /exists/{p}` on :8888. This is the ExecBackend's transport.

## 5. Session lifecycle & persistence

- **Mapping:** one **directly-created (cold) Sandbox** per conversation — *not* a
  warm-pool claim. Forced by two per-conversation requirements (see §5a and §5b)
  that a shared warm pool cannot satisfy.
- **Two PVCs:**
  1. **Workspace PVC** — `Sandbox.spec.volumeClaimTemplates`; mounted in the pod;
     holds the agent's files/repo/build output.
  2. **Conversation-state PVC** — mounted by the **agent-host**; holds Goose
     session state + the AG-UI event log for replay.
- **Suspend, don't delete** (verified against controller source, commit 52d1f97):
  - `operatingMode: Suspended` → controller deletes only the **Pod**; **PVCs are
    retained** (reconciled separately, owned by the Sandbox).
  - `operatingMode: Running` → recreates the Pod, re-mounts the same PVCs.
  - ⇒ the **Sandbox object is the durable handle** for a conversation. Keep it
    (suspended) instead of releasing the claim; revival is a resume, not a fresh
    warm-pool grab (which couldn't reattach a specific PVC).

### 5a. Credential broker auth (per-conversation ServiceAccount)

Credentialed work (git push, GitHub API) executes **in the pod** via `/execute`;
the **agent-host holds no credentials**. The pod authenticates to the broker
with its **projected SA token** (broker validates via K8s TokenReview, extracts
identity from the SA username) — the openhands-nix flow, preserved. The
`git-credential-broker` shim is lifted from openhands-nix.

For the broker to scope credentials to a conversation, the pod's SA must be
**unique per conversation** and **survive resume**. Source facts force the shape:

- SA lives in the `podTemplate`; templates default
  `automountServiceAccountToken: false` (must add a projected broker-audience
  token volume explicitly).
- A `SandboxClaim` **cannot override the SA** (only `additionalPodMetadata`,
  `env`, `volumeClaimTemplates`), and `env`/`volumeClaimTemplates` **force a
  cold start**.

⇒ Each conversation is a **cold-started `Sandbox`** with
`serviceAccountName: sandbox-{conversationId}`. On resume the pod is recreated
from the same template → same SA → broker re-validates the same identity. The
platform manages the per-conversation SA + RBAC lifecycle (create before the
Sandbox; GC on conversation delete).

**Warm pools are repurposed:** fast generic capacity where per-conversation
identity/PVCs aren't needed — not the credentialed/persistent conversation
sandbox.

### 5b. Per-conversation PVCs

## 6. Components (Design-stage; interfaces only)

1. **`agent-host/`** (TypeScript; was `wrapper/`) — runs `goose acp` per
   conversation; ACP client + ACP→AG-UI bridge; ExecBackend backed by the
   agent-sandbox SDK; AG-UI server to the browser; mounts/owns the
   conversation-state PVC. Topology-agnostic: N goose procs per host pod now,
   1-per-pod later.
2. **`pkgs/sandbox-image/`** — *generic* Nix image: agent-sandbox runtime
   contract (:8888) + overlay /nix store + lazy shims + skills. No agent.
3. **`modules/`** — kubenix: `SandboxTemplate` (with two volumeClaimTemplates),
   `SandboxWarmPool`, `Sandbox`; agent-host Deployment; (post-PoC) broker,
   webhooks.
4. **`ui/`** — assistant-ui + AG-UI runtime pointed at the agent-host.
5. **(post-PoC) `services/`** — broker, webhooks.

## 7. PoC scope (end-to-end thin slice)

**Goal:** open the UI → give a task → Goose (in the agent-host) drives a Nix
sandbox via the agent-sandbox API → events stream live to the browser → suspend
& revive the conversation with workspace + history intact.

In scope: generic sandbox image · kubenix `SandboxTemplate`+`SandboxWarmPool`
with two PVCs · agent-host (goose + ACP→AG-UI + SDK exec backend + conversation
PVC) · minimal assistant-ui frontend · suspend/resume revival.

Deferred: broker, webhooks, multi-agent selection, NetworkPolicy tuning,
warm-pool autoscaling, 1-goose-per-pod topology.

## 8. Open items

- **AG-UI transport** (SSE vs WS).
- **Conversation-state PVC mounting** by a multi-session agent-host (per-conv
  volume management).
- **NetworkPolicy** (default-deny blocks in-cluster broker) — post-PoC when
  broker lands.
- **SA token projection** for broker auth — post-PoC.
- **Goose session persistence** — confirm Goose can persist/rehydrate session
  state onto the conversation PVC (vs. reconstruct from the event log).

## 9. Reference

- Upstream: `kubernetes-sigs/agent-sandbox` (CRDs, runtime contract, SDKs;
  controller source verified at commit 52d1f97).
- Sibling: `../openhands-nix` (skills, broker, webhooks, common, image patterns).
- Agent: `goose acp` (nixpkgs `goose-cli`).
- UI: `assistant-ui` (native AG-UI runtime).
