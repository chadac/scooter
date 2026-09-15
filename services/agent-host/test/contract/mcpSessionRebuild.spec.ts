/**
 * Tier 1 contract — the bridge REBUILDS its agent session when the sandbox's MCP
 * server set changes, and leaves it alone when it doesn't.
 *
 * This is the guard that makes port auto-assignment in
 * modules/sandbox-os/mcp-servers.nix safe. A `scooter-rebuild` can hand a port to a
 * DIFFERENT server (add a name that sorts first and everything shifts up one), so a
 * session still holding `sandbox:alpha -> :9700` would talk to the new occupant of
 * :9700 while still calling it alpha. That mis-wires SILENTLY — strictly worse than
 * a dead port, which at least fails loudly. Re-resolving per run and comparing the
 * fingerprint is what prevents it. See PR #521 review.
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
  name: `sandbox:${name}`,
  url: `http://127.0.0.1:${port}/mcp`,
  headers: [],
});

/** A provider whose every created client records the mcpServers it was given at
 *  newSession. A fresh fake agent per createClient, so a rebuild is observable as a
 *  genuinely new client rather than a re-used one. */
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
    // The sandbox's set, as the registry would resolve it. Mutable: a rebuild moves it.
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

    // A rebuild adds a server sorting before alpha, so alpha is renumbered to 9701 and
    // :9700 now belongs to something else entirely.
    offered = [server("aardvark", 9700), server("alpha", 9701)];

    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients(), "a changed set must create a NEW client").toBe(2);
    expect(rec.sessions(), "and a second session").toHaveLength(2);
    const alpha = rec.sessions()[1].find((s) => s.name === "sandbox:alpha");
    expect(alpha?.url, "alpha must be re-registered at its NEW port").toContain("9701");

    await bridge.stop();
  });

  it("does NOT rebuild when the set is unchanged", async () => {
    // Rebuilding on every message would drop the agent's session (and re-seed history)
    // constantly — the cost of getting this wrong in the other direction.
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const rec = recordingProvider(exec);
    const offered = [server("alpha", 9700)];

    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG,
      exec,
      acpProviders: [rec.provider],
      // A NEW array each call with equal contents — the comparison must be by value,
      // not identity, or it would rebuild every single run.
      resolveMcpServers: async () => offered.map((s) => ({ ...s })),
    });

    await bridge.prompt({ threadId: "t1", text: "one" });
    await bridge.prompt({ threadId: "t1", text: "two" });

    expect(rec.clients(), "an unchanged set must reuse the session").toBe(1);
    expect(rec.sessions()).toHaveLength(1);

    await bridge.stop();
  });

  it("keeps the current session when the resolver fails", async () => {
    // The pod may be asleep or exec may blip. Failing toward "keep the session we have"
    // is right: the alternative is tearing down a working agent over a transient read.
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
    // Every existing deployment/test takes this path; it must not start re-resolving.
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
});
