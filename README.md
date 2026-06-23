# kubenix-agent-sandbox

A Nix-powered agent platform layered over the Kubernetes
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller.

> **Status:** early Design stage. Interfaces and structure only — not yet
> implemented. See [`docs/DESIGN.md`](docs/DESIGN.md).

## Idea

agent-sandbox provides a fleet of pre-warmed, generic, isolated **execution
environments** (the body). This project adds the missing layers using
off-the-shelf standards:

- **Brain:** an off-the-shelf **ACP** agent (first: **Goose**, from nixpkgs),
  run **outside** the sandbox in an **agent-host**. No agent loop is written.
- **UI seam:** **AG-UI**, consumed natively by **assistant-ui**.
- **Exec:** the agent's actions are serviced by calling the **agent-sandbox API**
  against the session's pod (ACP `terminal/*`/`fs/*` → `/execute`, files).
- **Nix:** a generic sandbox image (overlay store, lazy shims, skills).
- **kubenix:** modules generating the per-conversation `Sandbox` + supporting
  resources.

```
browser (assistant-ui / AG-UI)
   │ AG-UI events
agent-host  ── goose acp per conversation ── ACP⇄AG-UI bridge
   │            └ conversation-state PVC (brain)
   └ ACP terminal*/fs* ── agent-sandbox API ──► Sandbox pod (body)
                                                  ├ :8888 runtime contract
                                                  ├ Nix overlay store + skills
                                                  └ workspace PVC
agent-sandbox controller: warm pools · suspend(=drop Pod, keep PVCs)/resume
```

## Layout

| Path | What |
|------|------|
| `flake.nix` | Nix entry: sandbox image, agent-host, ui, agent (goose) |
| `agent-host/` | TypeScript: ACP⇄AG-UI bridge, session manager, SDK exec backend |
| `pkgs/sandbox-image/` | Generic Nix sandbox image + runtime-server (`:8888` contract) |
| `modules/` | kubenix: per-conversation cold Sandbox (SA + 2 PVCs), agent-host, warm pool |
| `ui/` | assistant-ui frontend + reusable AG-UI client library |
| `skills/` | Markdown agent skills (Nix usage, etc.) |
| `docs/DESIGN.md` | Full design |

## Key decisions

- **Agent runs outside the pod** — agent-sandbox is execution-as-a-service.
- **One cold `Sandbox` per conversation** (not a warm-pool claim): required for a
  per-conversation ServiceAccount (broker identity) and two persistent PVCs.
- **Suspend, don't delete** — the `Sandbox` object is the durable conversation
  handle; resume revives the same SA + PVCs.
- **Credentials** flow via the openhands-nix-style **broker**: the pod
  authenticates with its projected SA token; the agent-host holds none.

## Provenance

Distilled from `../openhands-nix` (skills, broker, webhooks, image patterns),
re-targeted from OpenHands' bundled runtime onto agent-sandbox + ACP + AG-UI.
