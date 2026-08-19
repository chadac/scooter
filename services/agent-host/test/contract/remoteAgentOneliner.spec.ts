/**
 * Tier 1 contract — the BYO "Connect your Claude agent" one-liner builder. Locks the wss URL
 * derivation + the docker one-liner shape (token + url baked in). See remoteAgentOneliner.ts.
 */

import { describe, it, expect } from "vitest";

import { connectWsUrl, dockerCommand, createRemoteAgentUi } from "../../src/acp/remoteAgentOneliner.js";
import { verifyJoinToken } from "../../src/auth/remoteAgentToken.js";

describe("connectWsUrl (the webhooks bridge)", () => {
  it("maps http→ws, https→wss, bare-host→wss, always the /claude-bridge/connect path", () => {
    expect(connectWsUrl("https://webhooks.example.com")).toBe("wss://webhooks.example.com/claude-bridge/connect");
    expect(connectWsUrl("http://webhooks.odin.lan")).toBe("ws://webhooks.odin.lan/claude-bridge/connect");
    expect(connectWsUrl("webhooks.odin.lan")).toBe("wss://webhooks.odin.lan/claude-bridge/connect");
    expect(connectWsUrl("https://host/")).toBe("wss://host/claude-bridge/connect"); // trailing slash trimmed
  });
  it("falls back to a placeholder when no bridge URL is configured", () => {
    expect(connectWsUrl(undefined)).toContain("<your-webhooks-host>");
  });
});

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

describe("createRemoteAgentUi", () => {
  it("mints a VERIFIABLE owner-bound token + a one-liner containing it", () => {
    const secret = "s3cr3t";
    const ui = createRemoteAgentUi({ joinSecret: secret, bridgeUrl: "https://webhooks.odin.lan", isConnected: () => false });
    const { token, dockerCommand: cmd, wsUrl } = ui.mint("alice");

    const v = verifyJoinToken(token, secret);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims.owner).toBe("alice");
    expect(wsUrl).toBe("wss://webhooks.odin.lan/claude-bridge/connect");
    expect(cmd).toContain(token);
    expect(cmd).toContain(wsUrl);
  });

  it("isConnected: prefers the async (durable) check, falls back to sync, else false", async () => {
    const sync = createRemoteAgentUi({ joinSecret: "s", isConnected: (o) => o === "alice" });
    expect(await sync.isConnected("alice")).toBe(true);
    expect(await sync.isConnected("bob")).toBe(false);
    // async (durable) wins over sync when both are wired.
    const both = createRemoteAgentUi({
      joinSecret: "s",
      isConnected: () => false,
      isConnectedAsync: async (o) => o === "carol",
    });
    expect(await both.isConnected("carol")).toBe(true);
    expect(await both.isConnected("alice")).toBe(false);
    // neither → false.
    expect(await createRemoteAgentUi({ joinSecret: "s" }).isConnected("alice")).toBe(false);
  });
});
