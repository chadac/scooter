# Bring your own Claude

Users can serve their own conversations with **their own Claude subscription** — the model runs
on their machine, while the conversation, its sandbox, and every tool call stay in the cluster.

## How it works

```
laptop container  ──wss──▶  BYOC controller  ◀──http──  agent-host replicas
 (the brain)                (owns the socket)             (the conversation)
        ▲                                                      │
        └───── tool calls tunnel back to the CLOUD sandbox ────┘
```

- The user runs one container (`docker run …` — the Settings page generates the exact
  command). It dials **out** over WebSocket; nothing on the laptop listens.
- The controller holds every container socket, so **any** host replica can drive **any**
  container. Conversations route to the user's container when it is online and fall back to
  the platform's floor model when it is not.
- Tool calls tunnel back into the cloud sandbox — the user's machine never executes the
  agent's commands.

## Enabling it

```nix
agentSandbox.byoc.enable = true;
```

One option: the controller, its (deliberately unauthenticated) `/byoc` connect path on your
existing ingress host, and the Settings UI. See the
[configuration reference](../reference/options/index.md) for the knobs.

## Security model

- First connect: a short-lived, owner-bound **join token** (minted from the authenticated
  Settings page) registers the container's **Ed25519 device key**.
- Every later connect: the container signs a server nonce — no long-lived bearer credential,
  reconnects survive laptop sleep and container restarts indefinitely.
- Up to three devices per user, least-recently-seen evicted; devices are listed and revocable
  in Settings.
- A rejected container is loud on **both** ends: the container log says why and backs off; the
  Settings page shows the failure and the fix.

## Guardrails

- Only **human-triggered** runs (UI, chat integrations) are eligible for a personal
  container — scheduled and webhook-triggered runs never silently consume a user's
  subscription.
- Concurrent conversations on one container are isolated per session: transcripts, tool
  calls, and approvals route only to the conversation they belong to.
