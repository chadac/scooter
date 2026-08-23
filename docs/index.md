# Scooter

A Nix-powered agent platform layered over the Kubernetes
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller: agent-sandbox
provides the execution **body** (pods, warm pools, suspend/resume); Scooter adds the **brain**
(an off-the-shelf ACP agent driven from outside the sandbox) and a **conversation UI**.

<!-- PITCH: this landing page is intentionally minimal — the positioning/sales copy is
     hand-written, not generated. Replace freely; the structural docs live in the nav. -->

## What it does

- **One durable sandbox per conversation** — a real NixOS dev environment (systemd PID 1) that
  suspends when idle and resumes with its state intact, holding your workspace and installed
  tools across days.
- **The agent lives outside the pod** — Scooter drives the sandbox through the Kubernetes exec
  API, so the sandbox stays a clean execution environment and the agent can be swapped,
  upgraded, or brought by the user without touching it.
- **Bring your own Claude** — users can run a small container on their own machine and serve
  their conversations with their own Claude subscription, while tools still execute in the
  cloud sandbox.
- **Declarative to the bone** — the whole platform is a Nix flake: images, Kubernetes
  manifests (kubenix), and every configuration option in one typed module system.
  [The option reference](reference/options.md) is generated from it.

## Where to start

- [Getting started](getting-started.md) — deploy the platform to a cluster.
- [Features](features/index.md) — what's in the box.
- [Configuration options](reference/options.md) — every `agentSandbox.*` option, generated
  from the modules.
