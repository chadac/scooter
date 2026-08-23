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
