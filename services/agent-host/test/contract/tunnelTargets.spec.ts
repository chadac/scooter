/**
 * Tier 1 contract — tunnel target resolution, the SECURITY BOUNDARY for MCP over the wire.
 *
 * A BYO container asks for a NAMED target; the agent-host maps it to a real URL. The rules
 * here are what keep a tunnel from a user's laptop from becoming arbitrary cluster network
 * access, so they are pinned before the implementation exists.
 *
 * The conversation id is ALWAYS supplied server-side (from the stream's session), never read
 * from the container's frame — a container that could name another conversation's resources is
 * the cross-owner hole the attach path already guards against.
 */

import { describe, it, expect } from "vitest";

import { resolveTunnelTarget, offeredTunnelServers } from "../../src/acp/tunnelTargets.js";

const deps = {
  mcpUrlFor: (conv: string) => `http://127.0.0.1:8080/mcp?conv=${encodeURIComponent(conv)}`,
};

describe("tunnel target resolution", () => {
  it("resolves scooter-env to THIS conversation's MCP endpoint", () => {
    const r = resolveTunnelTarget("scooter-env", "conv-a", deps);
    expect(r.ok).toBe(true);
    expect(r.ok && r.target.url).toBe("http://127.0.0.1:8080/mcp?conv=conv-a");
    expect(r.ok && r.target.rule).toBe("scooter-env");
  });

  it("scopes the endpoint to the SERVER-SIDE conversation, so streams cannot cross", () => {
    // Two sessions, two conversations: each resolves to its own ?conv=. The container never
    // supplies this — it comes from the stream's session.
    const a = resolveTunnelTarget("scooter-env", "conv-a", deps);
    const b = resolveTunnelTarget("scooter-env", "conv-b", deps);
    expect(a.ok && a.target.url).not.toBe(b.ok && b.target.url);
  });

  it("REJECTS an unknown target rather than half-working", () => {
    const r = resolveTunnelTarget("something-else", "conv-a", deps);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/unknown target/i);
  });

  it("REJECTS a raw host:port — names only, never network addresses", () => {
    // The whole reason this is a named mux and not a TCP tunnel.
    for (const bad of ["127.0.0.1:8080", "http://10.0.0.5:9000", "kubernetes.default.svc:443"]) {
      const r = resolveTunnelTarget(bad, "conv-a", deps);
      expect(r.ok, `${bad} must not resolve`).toBe(false);
    }
  });

  it("RESERVES sandbox:<name> — recognised but not resolvable yet, and it says so", () => {
    // The agent will declare MCP servers in its nixosConfiguration later; until that exists an
    // unimplemented target must fail loudly, not silently behave like scooter-env.
    const r = resolveTunnelTarget("sandbox:my-server", "conv-a", deps);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/not (yet )?(supported|implemented)|sandbox/i);
  });

  it("offers NOTHING when the MCP endpoint is not configured", () => {
    // No endpoint -> no scooter-env -> the container starts no proxy, rather than one that
    // dead-ends on every call.
    expect(offeredTunnelServers("conv-a", {})).toEqual([]);
  });

  it("offers scooter-env by NAME when the endpoint exists", () => {
    const offered = offeredTunnelServers("conv-a", deps);
    expect(offered.map((s) => s.name)).toEqual(["scooter-env"]);
  });
});

// --- the conversation token on a tunnelled target (issue #700) ----------------------
describe("tunnel target credentials", () => {
  const withHeaders = {
    mcpUrlFor: (_conv: string) => "http://127.0.0.1:8080/mcp",
    mcpHeadersFor: (conv: string) => [{ name: "Authorization", value: `Bearer token-for-${conv}` }],
  };

  it("attaches THIS conversation's token, resolved server-side", () => {
    const r = resolveTunnelTarget("scooter-env", "conv-a", withHeaders);
    expect(r.ok && r.target.headers).toEqual([
      { name: "Authorization", value: "Bearer token-for-conv-a" },
    ]);
  });

  it("gives two conversations different credentials, as it does different scopes", () => {
    const a = resolveTunnelTarget("scooter-env", "conv-a", withHeaders);
    const b = resolveTunnelTarget("scooter-env", "conv-b", withHeaders);
    expect(a.ok && a.target.headers).not.toEqual(b.ok && b.target.headers);
  });

  it("attaches none when no secret is configured, leaving the tunnel as it was", () => {
    const r = resolveTunnelTarget("scooter-env", "conv-a", { mcpUrlFor: withHeaders.mcpUrlFor });
    expect(r.ok && r.target.headers).toEqual([]);
  });

  // The container runs on the USER'S machine. Offering it a credential would be
  // handing them one; the agent-host injects when it proxies instead.
  it("never offers the credential to the container in the server list", () => {
    const offered = offeredTunnelServers("conv-a", withHeaders);
    expect(offered.every((o) => o.headers.length === 0)).toBe(true);
  });
});
describe("scooter-broker — the contrib provider tools", () => {
  const withBroker = { ...deps, brokerMcpUrlFor: () => "http://127.0.0.1:8080/broker-mcp" };

  it("THE BUG: a BYO agent is offered scooter-broker, not just scooter-env", () => {
    // Without it the agent has the github SKILL telling it to call agent-broker
    // and no github tool to call. Observed live on scooter.chadac.me.
    const names = offeredTunnelServers("c1", withBroker).map((s) => s.name);
    expect(names).toContain("scooter-env");
    expect(names).toContain("scooter-broker");
  });

  it("resolves to the broker proxy URL, with the conversation token attached", () => {
    const r = resolveTunnelTarget("scooter-broker", "c1", {
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

  it("is NOT offered when the broker is unconfigured", () => {
    const names = offeredTunnelServers("c1", deps).map((s) => s.name);
    expect(names).toEqual(["scooter-env"]);
  });

  it("refuses the name when the broker is unconfigured, rather than half-working", () => {
    const r = resolveTunnelTarget("scooter-broker", "c1", deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not configured/);
  });

  it("the conversation id is still server-side — the URL is not container-chosen", () => {
    // The broker URL takes no conversation id at all, so a container cannot name
    // another conversation's broker scope through this target.
    const a = resolveTunnelTarget("scooter-broker", "conv-a", withBroker);
    const b = resolveTunnelTarget("scooter-broker", "conv-b", withBroker);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.target.url).toBe(b.target.url);
  });

  it("an arbitrary host:port is still refused (names only)", () => {
    const r = resolveTunnelTarget("http://10.0.0.1:8080", "c1", withBroker);
    expect(r.ok).toBe(false);
  });
});

