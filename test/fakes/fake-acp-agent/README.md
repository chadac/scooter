# fake-acp-agent (in-pod variant)

A deterministic ACP *agent* used by Tier 2/3 tests instead of real Goose.

Two forms:
- **In-process** (`agent-host/test/fakes/fakeAcpAgent.ts`) — for Tier 1.
- **In-pod** (this dir) — a small `goose acp`-compatible stdio binary baked into
  a sandbox-image variant, so the agent-host can spawn it and cluster/E2E tests
  stay key-free and reproducible.

The script is selected via env / query param (e.g. `?script=permission`) so E2E
tests can choose canned flows (message-only, tool-call, permission-required,
error).

Design stage: spec only. At implementation, this is a tiny JSON-RPC-over-stdio
program (any language) honoring the ACP agent methods and emitting scripted
`session/update` notifications, plus a Nix derivation:

    pkgs.callPackage ./fake-acp-agent { }  ->  bin/fake-acp-agent

and a sandbox-image variant that uses it as the spawned ACP agent.
