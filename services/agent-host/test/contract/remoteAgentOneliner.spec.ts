/**
 * Tier 1 contract — the BYO "Connect your Claude agent" one-liner builder. Locks the wss URL
 * derivation + the docker one-liner shape (token + url baked in). See remoteAgentOneliner.ts.
 */

import { describe, it, expect } from "vitest";

import { connectWsUrl, dockerCommand, createRemoteAgentUi } from "../../src/acp/remoteAgentOneliner.js";
import { verifyJoinToken } from "../../src/auth/remoteAgentToken.js";

// connectWsUrl + createRemoteAgentUi now target the BYOC CONTROLLER (per-owner
// /byoc/ws/<session-id>), not the retired webhooks bridge — see remoteAgentOnelinerByoc.spec.ts.
// Only dockerCommand is transport-agnostic, so it stays here.

describe("dockerCommand", () => {
  it("bakes the url + token + the restart-always + volume + 1717 publish", () => {
    const cmd = dockerCommand("wss://s/remote-agent/connect", "TOK", "ghcr.io/x/agent:1");
    expect(cmd).toContain("--restart always");
    expect(cmd).toContain("-p 127.0.0.1:34579:34579");
    expect(cmd).toContain("-v scooter-claude:/root/.claude");
    expect(cmd).toContain("ghcr.io/x/agent:1");
    expect(cmd).toContain("--url wss://s/remote-agent/connect");
    expect(cmd).toContain("--join TOK");
  });
});

