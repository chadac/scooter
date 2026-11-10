/**
 * The bridge rebuilds its agent session when the sandbox's MCP server set changes and
 * leaves it alone when it does not. Port auto-assignment in
 * modules/sandbox-os/mcp-servers.nix can hand a port to a different server on a
 * `scooter-rebuild`, so the set is re-resolved per run and compared by fingerprint.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge } from "../../src/bridge.js";
import type { AcpProvider } from "../../src/acp/provider.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";
import type { OfferedMcpServer } from "../../src/agent/mcpServerRegistry.js";

const BRIDGE_CONFIG = {
  cwd: "/workspace",
  skillsDir: "/skills",
  agent: { command: "fake", args: [], env: {} },
  sandbox: { name: "s", namespace: "ns" },
};

const server = (name: string, port: number): OfferedMcpServer => ({
  type: "http",
  name: `sandbox-${name}`,
  url: `http://127.0.0.1:${port}/mcp`,
  headers: [],
});

/** A provider whose clients record the mcpServers given at newSession, with a fresh fake agent per createClient so a rebuild is observable. */
function recordingProvider(exec: ReturnType<typeof createSandboxExecBackend>) {
  const sessions: OfferedMcpServer[][] = [];
  let clients = 0;
  const provider: AcpProvider = {
    id: "floor",
    kind: "goose",
    priority: 0,
    eligible: () => true,
    createClient: () => {
      clients++;
      const agent = createFakeAcpAgent();
      agent.setScript([
        { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
        { finish: { stopReason: "end_turn" } },
      ]);
      const client = acpClientFromTransport(agent.transport, exec);
      return new Proxy(client, {
        get(target, prop, recv) {
          if (prop === "newSession") {
            return async (params: { mcpServers?: OfferedMcpServer[] }) => {
              sessions.push((params.mcpServers ?? []) as OfferedMcpServer[]);
              return (target as unknown as { newSession: (p: unknown) => Promise<{ sessionId: string }> })
                .newSession(params);
            };
          }
          return Reflect.get(target, prop, recv);
        },
      });
    },
  };
  return { provider, sessions: () => sessions, clients: () => clients };
}

describe("bridge — sandbox MCP servers change under a live conversation", () => {
  it("rebuilds the session when a server's port is reassigned", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    // The sandbox's set as the registry would resolve it; a rebuild moves it.
    let offered = [server("alpha", 9700)];

    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG,
      exec,
      acpProviders: [rec.provider],
      resolveMcpServers: async () => offered,
    });

    await bridge.prompt({ threadId: "t1", text: "one" });
    expect(rec.sessions()).toHaveLength(1);
    expect(rec.sessions()[0][0].url).toContain("9700");

    // A rebuild adds a server sorting before alpha, so alpha is renumbered to 9701.
    offered = [server("aardvark", 9700), server("alpha", 9701)];

    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients(), "a changed set must create a NEW client").toBe(2);
    expect(rec.sessions(), "and a second session").toHaveLength(2);
    const alpha = rec.sessions()[1].find((s) => s.name === "sandbox-alpha");
    expect(alpha?.url, "alpha must be re-registered at its NEW port").toContain("9701");

    await bridge.stop();
  });

  it("does NOT rebuild when the set is unchanged", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    const offered = [server("alpha", 9700)];

    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG,
      exec,
      acpProviders: [rec.provider],
      // A new array each call with equal contents, so the comparison must be by value.
      resolveMcpServers: async () => offered.map((s) => ({ ...s })),
    });

    await bridge.prompt({ threadId: "t1", text: "one" });
    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients(), "an unchanged set must reuse the session").toBe(1);
    expect(rec.sessions()).toHaveLength(1);

    await bridge.stop();
  });

  it("keeps the current session when the resolver fails", async () => {
    // The pod may be asleep or exec may blip.
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    let fail = false;

    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG,
      exec,
      acpProviders: [rec.provider],
      resolveMcpServers: async () => {
        if (fail) throw new Error("pod asleep");
        return [server("alpha", 9700)];
      },
    });

    await bridge.prompt({ threadId: "t1", text: "one" });
    fail = true;
    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients(), "a resolver failure must not rebuild").toBe(1);

    await bridge.stop();
  });

  it("leaves the static config path untouched when no resolver is configured", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);

    const bridge = createSessionBridge({
      config: { ...BRIDGE_CONFIG, mcpServers: [server("static", 1234)] },
      exec,
      acpProviders: [rec.provider],
    });

    await bridge.prompt({ threadId: "t1", text: "one" });
    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients()).toBe(1);
    expect(rec.sessions()[0][0].url).toContain("1234");

    await bridge.stop();
  });

  it("starts the session with the static set when the resolver fails on the FIRST run", async () => {
    // No session to keep yet; a blip must not fail the run.
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);

    const bridge = createSessionBridge({
      config: { ...BRIDGE_CONFIG, mcpServers: [server("static", 1234)] },
      exec,
      acpProviders: [rec.provider],
      resolveMcpServers: async () => {
        throw new Error("exec blip");
      },
    });

    await bridge.prompt({ threadId: "t1", text: "one" });

    expect(rec.sessions()).toHaveLength(1);
    expect(rec.sessions()[0].map((s) => s.name)).toEqual(["sandbox-static"]);

    await bridge.stop();
  });

  it("starts at once on a cold sandbox and picks its servers up on a later run", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    // A pod still starting: the resolve hangs until released.
    let release!: (s: OfferedMcpServer[]) => void;
    let calls = 0;
    const bridge = createSessionBridge({
      config: { ...BRIDGE_CONFIG, mcpServers: [server("static", 1234)] },
      exec,
      acpProviders: [rec.provider],
      mcpResolveWaitMs: 20,
      resolveMcpServers: () => {
        calls++;
        return new Promise((r) => (release = r));
      },
    });

    await bridge.prompt({ threadId: "t1", text: "one" });
    expect(rec.sessions()[0].map((s) => s.name)).toEqual(["sandbox-static"]);

    await bridge.prompt({ threadId: "t1", text: "two" });
    expect(calls, "a slow resolve is shared, not stacked").toBe(1);
    expect(rec.clients(), "no answer yet, so no rebuild").toBe(1);

    release([server("static", 1234), server("kubernetes", 9700)]);
    await bridge.prompt({ threadId: "t1", text: "three" });
    expect(rec.clients(), "the sandbox's servers rebuild the session").toBe(2);
    expect(rec.sessions()[1].map((s) => s.name)).toEqual(["sandbox-static", "sandbox-kubernetes"]);

    await bridge.stop();
  });

  it("does NOT rebuild a provider that brings its own MCP set", async () => {
    // A constant set has nothing to re-offer.
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    const own = [{ type: "http" as const, name: "scooter-env", url: "tunnel://scooter-env", headers: [] }];
    const provider: AcpProvider = { ...rec.provider, mcpServersFor: () => own };

    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG,
      exec,
      acpProviders: [provider],
      resolveMcpServers: async () => [server("alpha", 9700)],
    });

    await bridge.prompt({ threadId: "t1", text: "one" });
    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients(), "its session must be reused").toBe(1);
    expect(rec.sessions()[0]).toEqual(own);

    await bridge.stop();
  });

  it("re-offers a BYO provider's set when the sandbox's servers change", async () => {
    // A server added by scooter-rebuild or Settings reaches a BYO session on the next message.
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    const provider: AcpProvider = {
      ...rec.provider,
      mcpServersFor: (_conv, resolved) =>
        resolved.map((s) => ({ type: "http" as const, name: s.name, url: `tunnel://${s.name}`, headers: [] })),
    };
    let offered = [server("fetch", 9780)];

    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG,
      exec,
      acpProviders: [provider],
      resolveMcpServers: async () => offered,
    });

    await bridge.prompt({ threadId: "t1", text: "one" });
    await bridge.prompt({ threadId: "t1", text: "two" });
    expect(rec.clients(), "an unchanged set keeps the session").toBe(1);

    offered = [server("fetch", 9780), server("jupyter", 9700)];
    await bridge.prompt({ threadId: "t1", text: "three" });
    expect(rec.clients(), "the new server rebuilds the session").toBe(2);
    expect(rec.sessions()[1].map((s) => s.url)).toEqual(["tunnel://sandbox-fetch", "tunnel://sandbox-jupyter"]);

    // A port move behind the same name is the proxy's business, not the session's.
    offered = [server("fetch", 9781), server("jupyter", 9700)];
    await bridge.prompt({ threadId: "t1", text: "four" });
    expect(rec.clients()).toBe(2);

    await bridge.stop();
  });
});
