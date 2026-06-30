# Agent self-modify — follow-up (agent-host ownership + agent trigger)

Status: **DESIGN (for review)**.

The spike (PR #14) landed the in-pod foundation: `scooter-apply-module --module
<path>` builds `base + extraReconvergeModules + module` → registers a generation
→ switches → auto-rolls-back on failure, with the overlay store + PVC upper for
runtime builds. This follow-up adds the **agent-host side** so the AGENT can drive
it — owned by the brain (outside the pod), per the decided architecture.

## Architecture (decided in planning)

- The agent triggers a change **directly through the agent-host** — a first-class
  capability, NOT via the workspace/broker — so it never depends on its own
  compute environment to change it.
- The agent provides a **raw `module.nix`** (it's on NixOS; the `nix-dev-env`
  skill teaches modules). The in-pod `nix build` is the validation gate.
- The agent-host **owns the module**: it writes it into a **per-conversation
  ConfigMap** (durable across suspend/resume) AND triggers an **immediate in-pod
  re-converge** (live, not on the ~60s kubelet sync / next restart).
- Build-before-persist: the ConfigMap is updated ONLY after a clean switch, so it
  always holds a known-good module.

## Seams

### 1. Per-conversation module ConfigMap (agent-host-owned)
`k8sProvisioner.ts`:
- `create()` creates an EMPTY ConfigMap `conv-{id}-module` (data `{ "module.nix": "" }`)
  BEFORE the Sandbox — the podTemplate must mount it from pod birth (a CM created
  later won't appear as a volume). Idempotent on 409 like the SA.
- Mount it read-only at a NEW path, e.g. `/etc/agent-sandbox/scooter-conv`, and
  point `programs.scooterModule.dir` there (the agent's module is the converge
  source; the deployment's existing `scooter-tools` CM stays for its own tools).
- `destroy()` deletes it via `ignoreDeleteNotFound`.
- `conversation.nix` mirrors the CM + mount (kept in lockstep).

### 2. moduleManager (the apply orchestrator)
NEW `services/agent-host/src/session/moduleManager.ts`. On an apply request:
1. `client.upload("/run/agent-sandbox/scooter-conv/module.nix", rawModule)` — `/run`
   is tmpfs + writable; live path bypasses the slow ConfigMap sync.
2. `client.execute("scooter-apply-module --module /run/.../module.nix")` —
   builds+switches+rolls-back in-pod (the spike's gate).
3. On exit 0: persist `rawModule` to the ConfigMap (durability). On non-zero:
   do NOT persist; return the build/switch stderr to the agent.
- Serialize applies per conversation (refuse while one is in flight / the conv is
  suspending).
- Uses the same exec client the bridge uses (`createSandboxExecBackend`).

### 3. The agent-facing MCP tool
- ACP `newSession` accepts `mcpServers` (today `[]` at `client.ts:179`,
  `bridge.ts:396`). The agent-host runs a small **HTTP MCP server** (in-process)
  exposing one tool: `modify_environment(module_nix: string)` → routes to
  `moduleManager.apply(conversationId, module_nix)` → returns success or the
  build/switch error.
- Thread the MCP server's URL into `newSession({ cwd, mcpServers: [{ type: "http",
  url, headers, name }] })` per conversation (the bridge knows the conversationId,
  so the MCP call resolves to the right sandbox).
- Off unless enabled (a config flag): only real-goose sessions get it.

### 4. The skill
`skills/scooter-env.md` — teaches the agent the `modify_environment` tool: when to
use it (add a tool/service/package), that it takes a raw NixOS module, that a bad
module fails the build (it'll get the error back) and a bad switch auto-rolls-back.

## Test surface
- **Tier 1 (vitest):**
  - moduleManager: upload→execute→persist-only-on-exit-0; NO persist on non-zero
    (the gate); serialization. Fake `SandboxApiClient` + fake ConfigMap API.
  - ConfigMap manager: create-empty / persist / delete (404/409 tolerance).
  - MCP tool handler: maps a `modify_environment` call to moduleManager + returns
    the error text on failure.
  - sandboxManifest: the per-conversation module CM mount + (existing) overlay PVC.
- **Tier 2 (cluster):** provision a conv with the overlay image, drive a
  `modify_environment` (or moduleManager.apply directly), assert the tool appears
  in a later `shell` call AND survives suspend/resume (ConfigMap + PVC upper).
  This is the live-switch validation the nixosTest can't do (no backdoor in a pod).

## Decisions (confirmed)
1. **Host renders ONE final module** into the per-conversation CM;
   `scooterModule.dir` → that CM only. base-config + the apply expr stay unchanged.
2. **MCP transport = http** (in-process agent-host endpoint; the handler has direct
   access to moduleManager — no subprocess).
3. **Raw module.nix, NO guardrails.** The in-pod build is the eval gate and a bad
   switch auto-rolls-back (and a fresh pod re-applies the last-good CM), so the
   agent gets full NixOS power; we trust the safety net rather than a deny-list.
4. **Concurrency:** moduleManager serializes applies per conversation and holds a
   per-conv "applying" flag; the idle sweep refuses to suspend while it's set.
5. **Scope:** FULL vertical slice in this PR — moduleManager + per-conversation
   ConfigMap + MCP `modify_environment` tool + `scooter-env` skill + Tier-2 test.
