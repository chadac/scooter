# Conversations & sandboxes

Every conversation owns a **cold, dedicated `Sandbox`** — not a claim from a shared pool. That
is what makes a per-conversation ServiceAccount and persistent volumes possible: the sandbox is
the conversation's durable body.

## The sandbox

- A NixOS image with **systemd as PID 1** — real services, timers, and a login environment,
  not a bare shell in a scratch container.
- The agent's tool calls **exec into the pod via the Kubernetes API**; there is no in-pod
  agent or HTTP server. The sandbox stays a clean execution environment.
- The agent can **modify its own environment** declaratively: it edits the machine's Nix
  configuration and rebuilds, and the change persists with the conversation.

## Suspend, don't delete

An idle conversation's sandbox is **suspended** (the pod is torn down; the `Sandbox` object and
its volumes remain). The next prompt revives it:

- the workspace volume comes back as it was,
- the conversation's transcript is re-injected into the agent's fresh session, so it continues
  with full context — whichever provider serves the run, including a bring-your-own container
  that has never seen the conversation before,
- suspended conversations cost no CPU; the platform autoscales its own hosts to live demand.

## Multi-replica by construction

Conversation ownership lives in a `Conversation` custom resource — the **source of truth** for
existence, ownership, and liveness. A controller assigns each conversation to a host pod;
routing follows the assignment; phase (live/suspended) is continuously reconciled against the
sandbox's real state. Any replica can serve any conversation after a reassignment, and a
rollout cannot strand one.

## Subagents

A conversation can spawn subagents: full conversations that **share the parent's sandbox pod**,
run asynchronously, and report back. The parent can monitor, search, and interrupt a running
subagent.
