/**
 * Tunnel target resolution, the security boundary for MCP over the wire: a BYO container
 * asks for a named target and the agent-host maps it to a real URL, never a raw address.
 * The conversation id always comes from the stream's session, never from the container's
 * frame, and credentials are injected server-side rather than offered to the container.
 */

import { describe, it, expect } from "vitest";

import { resolveTunnelTarget, offeredTunnelServers } from "../../src/acp/tunnelTargets.js";
import type { OfferedMcpServer } from "../../src/agent/mcpServerRegistry.js";

const deps = {
  mcpUrlFor: (conv: string) => `http://127.0.0.1:8080/mcp?conv=${encodeURIComponent(conv)}`,
};

describe("tunnel target resolution", () => {
  it("resolves scooter-env to THIS conversation's MCP endpoint", async () => {
    const r = await resolveTunnelTarget("scooter-env", "conv-a", deps);
    expect(r.ok).toBe(true);
    expect(r.ok && r.target.url).toBe("http://127.0.0.1:8080/mcp?conv=conv-a");
    expect(r.ok && r.target.rule).toBe("scooter-env");
  });

  it("scopes the endpoint to the SERVER-SIDE conversation, so streams cannot cross", async () => {
    const a = await resolveTunnelTarget("scooter-env", "conv-a", deps);
    const b = await resolveTunnelTarget("scooter-env", "conv-b", deps);
    expect(a.ok && a.target.url).not.toBe(b.ok && b.target.url);
  });

  it("REJECTS an unknown target rather than half-working", async () => {
    const r = await resolveTunnelTarget("something-else", "conv-a", deps);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/unknown target/i);
  });

  it("REJECTS a raw host:port — names only, never network addresses", async () => {
    for (const bad of ["127.0.0.1:8080", "http://10.0.0.5:9000", "kubernetes.default.svc:443"]) {
      const r = await resolveTunnelTarget(bad, "conv-a", deps);
      expect(r.ok, `${bad} must not resolve`).toBe(false);
    }
  });

  it("refuses sandbox-<name> when the deployment has no sandbox MCP proxy", async () => {
    const r = await resolveTunnelTarget("sandbox-my-server", "conv-a", deps);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/not configured/);
  });

  it("offers NOTHING when the MCP endpoint is not configured", async () => {
    // With no endpoint the container starts no proxy, rather than one that dead-ends on every call.
    expect(offeredTunnelServers({})).toEqual([]);
  });

  it("offers scooter-env by NAME when the endpoint exists", async () => {
    const offered = offeredTunnelServers(deps);
    expect(offered.map((s) => s.name)).toEqual(["scooter-env"]);
  });
});

// --- the conversation token on a tunnelled target -----------------------------------
describe("tunnel target credentials", () => {
  const withHeaders = {
    mcpUrlFor: (_conv: string) => "http://127.0.0.1:8080/mcp",
    mcpHeadersFor: (conv: string) => [{ name: "Authorization", value: `Bearer token-for-${conv}` }],
  };

  it("attaches THIS conversation's token, resolved server-side", async () => {
    const r = await resolveTunnelTarget("scooter-env", "conv-a", withHeaders);
    expect(r.ok && r.target.headers).toEqual([
      { name: "Authorization", value: "Bearer token-for-conv-a" },
    ]);
  });

  it("gives two conversations different credentials, as it does different scopes", async () => {
    const a = await resolveTunnelTarget("scooter-env", "conv-a", withHeaders);
    const b = await resolveTunnelTarget("scooter-env", "conv-b", withHeaders);
    expect(a.ok && a.target.headers).not.toEqual(b.ok && b.target.headers);
  });

  it("attaches none when no secret is configured, leaving the tunnel as it was", async () => {
    const r = await resolveTunnelTarget("scooter-env", "conv-a", { mcpUrlFor: withHeaders.mcpUrlFor });
    expect(r.ok && r.target.headers).toEqual([]);
  });

  // The container runs on the user's machine, so the agent-host injects the credential when it proxies instead.
  it("never offers the credential to the container in the server list", async () => {
    const offered = offeredTunnelServers(withHeaders);
    expect(offered.every((o) => o.headers.length === 0)).toBe(true);
  });
});
describe("scooter-broker — the contrib provider tools", () => {
  const withBroker = { ...deps, brokerMcpUrlFor: () => "http://127.0.0.1:8080/broker-mcp" };

  it("THE BUG: a BYO agent is offered scooter-broker, not just scooter-env", async () => {
    // Without it the agent has the github skill telling it to call agent-broker and no github tool to call.
    const names = offeredTunnelServers(withBroker).map((s) => s.name);
    expect(names).toContain("scooter-env");
    expect(names).toContain("scooter-broker");
  });

  it("resolves to the broker proxy URL, with the conversation token attached", async () => {
    const r = await resolveTunnelTarget("scooter-broker", "c1", {
      ...withBroker,
      mcpHeadersFor: () => [{ name: "x-conv", value: "tok" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.url).toBe("http://127.0.0.1:8080/broker-mcp");
    expect(r.target.rule).toBe("scooter-broker");
    // The container never sees the broker SA token; the proxy attaches it.
    expect(r.target.headers).toEqual([{ name: "x-conv", value: "tok" }]);
  });

  it("is NOT offered when the broker is unconfigured", async () => {
    const names = offeredTunnelServers(deps).map((s) => s.name);
    expect(names).toEqual(["scooter-env"]);
  });

  it("refuses the name when the broker is unconfigured, rather than half-working", async () => {
    const r = await resolveTunnelTarget("scooter-broker", "c1", deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not configured/);
  });

  it("the conversation id is still server-side — the URL is not container-chosen", async () => {
    // The broker URL takes no conversation id at all, so a container cannot name
    // another conversation's broker scope through this target.
    const a = await resolveTunnelTarget("scooter-broker", "conv-a", withBroker);
    const b = await resolveTunnelTarget("scooter-broker", "conv-b", withBroker);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.target.url).toBe(b.target.url);
  });

  it("an arbitrary host:port is still refused (names only)", async () => {
    const r = await resolveTunnelTarget("http://10.0.0.1:8080", "c1", withBroker);
    expect(r.ok).toBe(false);
  });
});


// --- sandbox-declared MCP servers ---------------------------------------------------
describe("sandbox-<name> — the pod's own MCP servers", () => {
  // conv-a's pod declares jupyter; conv-b's declares fetch.
  const declared: Record<string, string[]> = { "conv-a": ["jupyter"], "conv-b": ["fetch"] };
  const withSandbox = {
    ...deps,
    mcpHeadersFor: (conv: string) => [{ name: "Authorization", value: `Bearer token-for-${conv}` }],
    sandboxMcpUrlFor: (name: string) => `http://127.0.0.1:8080/sandbox-mcp/${name}`,
    sandboxServerDeclared: async (conv: string, name: string) => (declared[conv] ?? []).includes(name),
  };
  const running = (...names: string[]): OfferedMcpServer[] =>
    names.map((n) => ({ type: "http", name: `sandbox-${n}`, url: `http://127.0.0.1:8080/sandbox-mcp/${n}`, headers: [{ name: "Authorization", value: "Bearer x" }] }));

  it("resolves a declared server to the sandbox-MCP proxy, with THIS conversation's token", async () => {
    const r = await resolveTunnelTarget("sandbox-jupyter", "conv-a", withSandbox);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.url).toBe("http://127.0.0.1:8080/sandbox-mcp/jupyter");
    expect(r.target.rule).toBe("sandbox");
    expect(r.target.headers).toEqual([{ name: "Authorization", value: "Bearer token-for-conv-a" }]);
  });

  it("REFUSES an unknown sandbox-x", async () => {
    const r = await resolveTunnelTarget("sandbox-x", "conv-a", withSandbox);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/no MCP server named "x"/);
  });

  it("REFUSES another conversation's server", async () => {
    const r = await resolveTunnelTarget("sandbox-fetch", "conv-a", withSandbox);
    expect(r.ok).toBe(false);
  });

  it("REFUSES a name that is not a bare server name", async () => {
    for (const bad of ["sandbox-", "sandbox-../mcp", "sandbox-10.0.0.1:9700", "sandbox-a/b"]) {
      const r = await resolveTunnelTarget(bad, "conv-a", { ...withSandbox, sandboxServerDeclared: async () => true });
      expect(r.ok, `${bad} must not resolve`).toBe(false);
    }
  });

  it("offers each running sandbox server by name, never its URL or token", () => {
    const offered = offeredTunnelServers(withSandbox, [
      { type: "http", name: "scooter-env", url: "http://127.0.0.1:8080/mcp", headers: [] },
      ...running("fetch", "jupyter"),
    ]);
    expect(offered.map((s) => s.name)).toEqual(["scooter-env", "sandbox-fetch", "sandbox-jupyter"]);
    for (const s of offered.slice(1)) {
      expect(s.url).toBe(`tunnel://${s.name}`);
      expect(s.headers).toEqual([]);
    }
  });

  it("offers no sandbox server when the deployment cannot resolve one", () => {
    expect(offeredTunnelServers(deps, running("jupyter")).map((s) => s.name)).toEqual(["scooter-env"]);
  });
});
