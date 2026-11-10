/**
 * The remote agent registry and the human-trigger allowlist: a closed connection is not
 * routable, a re-register supersedes and closes the prior connection, and a late close
 * of a superseded connection never evicts the current one.
 */

import { describe, it, expect } from "vitest";

import {
  createRemoteAgentRegistry,
  createRemotePersonalizedProvider,
  isHumanTrigger,
  HUMAN_TRIGGER_SOURCES,
  type AgentConnection,
} from "../../src/acp/remoteAgentRegistry.js";
import type { RemoteTransport } from "../../src/acp/remoteProtocol.js";
import type { RunContext } from "../../src/acp/provider.js";
import type { ExecBackend } from "../../src/types.js";

/** A stub transport that only reports open/closed. */
function stubTransport(): RemoteTransport & { setClosed: () => void } {
  let open = true;
  const closeCbs = new Set<() => void>();
  return {
    send: () => {},
    onFrame: () => () => {},
    isOpen: () => open,
    onClose: (cb) => {
      closeCbs.add(cb);
      return () => closeCbs.delete(cb);
    },
    close: () => {
      open = false;
      for (const cb of closeCbs) cb();
    },
    setClosed: () => {
      open = false;
    },
  };
}

const conn = (owner: string): AgentConnection & { transport: ReturnType<typeof stubTransport> } => {
  const transport = stubTransport();
  return { owner, transport };
};

const ctx = (over: Partial<RunContext>): RunContext => ({
  conversationId: "c1" as RunContext["conversationId"],
  ...over,
});

const fakeExec = {} as ExecBackend;

describe("HUMAN_TRIGGER_SOURCES / isHumanTrigger", () => {
  it("treats ui/slack/github/gitlab AND an undefined source (interactive) as human", () => {
    for (const s of ["ui", "slack", "github", "gitlab"]) expect(isHumanTrigger(s)).toBe(true);
    expect(isHumanTrigger(undefined)).toBe(true);
  });
  it("treats scheduler + any other automated source as NON-human (allowlist)", () => {
    expect(isHumanTrigger("scheduler")).toBe(false);
    expect(isHumanTrigger("webhook")).toBe(false);
    expect(isHumanTrigger("nudge")).toBe(false);
    expect(HUMAN_TRIGGER_SOURCES.has("scheduler")).toBe(false);
  });
});

describe("remote agent registry", () => {
  it("has()/get() reflect a registered, OPEN connection; a closed one is dropped", () => {
    const reg = createRemoteAgentRegistry();
    const c = conn("alice");
    reg.register(c);
    expect(reg.has("alice")).toBe(true);
    expect(reg.get("alice")?.owner).toBe("alice");

    c.transport.setClosed();
    expect(reg.has("alice")).toBe(false);
  });

  it("latest-wins: a re-register supersedes + closes the prior connection", () => {
    const reg = createRemoteAgentRegistry();
    const first = conn("alice");
    const second = conn("alice");
    reg.register(first);
    reg.register(second);
    expect(first.transport.isOpen()).toBe(false);
    expect(reg.get("alice")?.transport).toBe(second.transport);
  });

  it("unregister only clears when THIS transport is still current (no evicting the new one)", () => {
    const reg = createRemoteAgentRegistry();
    const first = conn("alice");
    const second = conn("alice");
    reg.register(first);
    reg.register(second);
    // A late close of the superseded first connection must not evict the second.
    reg.unregister("alice", first.transport);
    expect(reg.has("alice")).toBe(true);
    expect(reg.get("alice")?.transport).toBe(second.transport);
  });

  it("fires onOnline/onOffline hooks for durable persistence (badge across replicas)", () => {
    const online: string[] = [];
    const offline: string[] = [];
    const reg = createRemoteAgentRegistry({
      onOnline: (o) => online.push(o),
      onOffline: (o) => offline.push(o),
    });
    const c = conn("alice");
    reg.register(c);
    expect(online).toEqual(["alice"]);

    reg.unregister("alice", c.transport);
    expect(offline).toEqual(["alice"]);

    // onOffline fires only for the current transport, so a superseded connection's late close is silent.
    const first = conn("bob");
    const second = conn("bob");
    reg.register(first);
    reg.register(second);
    offline.length = 0;
    reg.unregister("bob", first.transport);
    expect(offline).toEqual([]);
  });
});

// The `remote-personalized` provider's eligibility resolves through the BYOC controller (see remotePersonalizedController.spec.ts).

// The offer's shape; the wiring that injects the conversation token (mcpHeadersFor) is covered by nixos-tests/byoc-mcp-e2e.nix.
describe("remote-personalized: the MCP offer", () => {
  it("offers both targets, and NEVER a credential with them", () => {
    const provider = createRemotePersonalizedProvider({
      registry: createRemoteAgentRegistry(),
      controllerUrl: "http://controller:8080",
      mcpUrlFor: (c: string) => `http://mcp/${c}`,
      mcpHeadersFor: (c: string) => [{ name: "Authorization", value: `Bearer ${c}` }],
      brokerMcpUrlFor: () => "http://broker/mcp",
    });
    const offered = provider.mcpServersFor?.("conv-1", []) ?? [];
    expect(offered.map((s) => s.name).sort()).toEqual(["scooter-broker", "scooter-env"]);
    // headers:[] is deliberate, since a credential handed to the container is one the user holds, so the token is injected server-side.
    for (const s of offered) expect(s.headers).toEqual([]);
  });

  it("OFFERS scooter-broker only when the broker resolver is supplied", () => {
    const provider = createRemotePersonalizedProvider({
      registry: createRemoteAgentRegistry(),
      controllerUrl: "http://controller:8080",
      mcpUrlFor: (c: string) => `http://mcp/${c}`,
      mcpHeadersFor: (c: string) => [{ name: "Authorization", value: `Bearer ${c}` }],
      // brokerMcpUrlFor omitted: the target must not be advertised, because the
      // inbound stream could not resolve it.
    });
    const names = (provider.mcpServersFor?.("conv-1", []) ?? []).map((s) => s.name);
    expect(names).toEqual(["scooter-env"]);
  });
});

describe("remote-personalized: the pod's own MCP servers", () => {
  const base = {
    registry: createRemoteAgentRegistry(),
    controllerUrl: "http://controller:8080",
    mcpUrlFor: (c: string) => `http://mcp/${c}`,
  };
  const resolved = [
    { type: "http" as const, name: "scooter-env", url: "http://mcp/conv-1", headers: [{ name: "Authorization", value: "t" }] },
    { type: "http" as const, name: "sandbox-jupyter", url: "http://agent-host/sandbox-mcp/jupyter", headers: [{ name: "Authorization", value: "t" }] },
  ];

  it("offers each running sandbox server as a tunnel name", () => {
    const provider = createRemotePersonalizedProvider({
      ...base,
      sandboxMcpUrlFor: (n: string) => `http://agent-host/sandbox-mcp/${n}`,
      sandboxServerDeclared: async () => true,
    });
    const offered = provider.mcpServersFor?.("conv-1", resolved) ?? [];
    expect(offered).toEqual([
      { type: "http", name: "scooter-env", url: "tunnel://scooter-env", headers: [] },
      { type: "http", name: "sandbox-jupyter", url: "tunnel://sandbox-jupyter", headers: [] },
    ]);
  });

  it("does not offer them when the tunnel could not resolve them", () => {
    const provider = createRemotePersonalizedProvider(base);
    expect((provider.mcpServersFor?.("conv-1", resolved) ?? []).map((s) => s.name)).toEqual(["scooter-env"]);
  });
});
