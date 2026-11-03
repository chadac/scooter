// A setup that times out must never reach the agent.

import { describe, it, expect } from "vitest";

import { createSessionBridge, type AguiEvent } from "../../src/bridge.js";
import type { AcpClient } from "../../src/acp/client.js";
import type { OfferedMcpServer } from "../../src/agent/mcpServerRegistry.js";
import { errorText } from "../../src/log.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";

const CONFIG = {
  cwd: "/workspace",
  skillsDir: "/skills",
  agent: { command: "fake", args: [], env: {} },
  sandbox: { name: "s", namespace: "ns" },
};

const server = (name: string): OfferedMcpServer => ({
  type: "http",
  name: `sandbox-${name}`,
  url: `http://127.0.0.1:9700/mcp`,
  headers: [],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const collect = (bridge: ReturnType<typeof createSessionBridge>) => {
  const events: AguiEvent[] = [];
  bridge.onEvent((e) => events.push(e));
  return events;
};

const finishes = () => [
  { emit: { sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text: "done" } } },
  { finish: { stopReason: "end_turn" } },
];

function setup() {
  const agent = createFakeAcpAgent();
  const exec = createSandboxExecBackend(createFakeSandboxApi());
  const base = acpClientFromTransport(agent.transport, exec);
  let closes = 0;
  const client: AcpClient = { ...base, close: async () => { closes++; await base.close(); } };
  return { agent, exec, client, closes: () => closes };
}

describe("bridge setup watchdog (setupTimeoutMs)", () => {
  it("does not count slow setup against the dead-on-arrival window", async () => {
    const { agent, exec, client } = setup();
    agent.setScript(finishes());
    const bridge = createSessionBridge({
      config: CONFIG,
      exec,
      acpClient: client,
      firstActivityTimeoutMs: 30,
      // Setup outlasting the DOA window, like a sandbox cold start.
      loadHistory: async () => (await sleep(80), []),
    });
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "hello" });

    expect(events.find((e) => e.type === "RUN_ERROR")).toBeUndefined();
    expect(events.filter((e) => e.type === "RUN_FINISHED")).toHaveLength(1);
    await bridge.stop();
  });

  it("never sends the prompt of a run whose setup timed out", async () => {
    const { agent, exec, client } = setup();
    agent.setScript(finishes());
    const bridge = createSessionBridge({
      config: CONFIG,
      exec,
      acpClient: client,
      setupTimeoutMs: 30,
      deathRetryMax: 0,
      loadHistory: async () => (await sleep(120), []),
    });
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "hello" });
    await sleep(250);

    const err = events.find((e) => e.type === "RUN_ERROR") as { code?: string } | undefined;
    expect(err?.code).toBe("setup_timeout");
    expect(agent.startedCount(), "the agent must never see the ended run's prompt").toBe(0);
    expect(events.filter((e) => e.type === "RUN_ERROR" || e.type === "RUN_FINISHED")).toHaveLength(1);
    await bridge.stop();
  });

  it("retries while the ended run's setup still hangs, and that setup cannot disturb the retry", async () => {
    const { agent, exec, client, closes } = setup();
    agent.setScript(finishes());
    let calls = 0;
    const bridge = createSessionBridge({
      config: CONFIG,
      exec,
      acpClient: client,
      setupTimeoutMs: 40,
      deathRetryMax: 1,
      deathRetryBaseMs: 10,
      // Call 2 hangs, then answers a set that would rebuild.
      resolveMcpServers: async () => {
        calls++;
        if (calls === 2) {
          await sleep(300);
          return [server("late")];
        }
        return [server("alpha")];
      },
    });
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "hello" });

    await sleep(200);
    expect((events.find((e) => e.type === "RUN_ERROR") as { code?: string }).code).toBe("setup_timeout");
    expect(events.some((e) => e.type === "RUN_FINISHED"), "the retry ran while setup hung").toBe(true);
    expect(agent.startedCount(), "only the retry's prompt was sent").toBe(1);

    await sleep(200); // the hung setup returns its stale answer
    expect(closes(), "a stale setup must not close the live session").toBe(0);
    await bridge.prompt({ threadId: "t1", text: "again" });
    expect(agent.startedCount()).toBe(2);
    await bridge.stop();
  });

  it("reports a JSON-RPC rejection's own message, not [object Object]", async () => {
    const { exec, client } = setup();
    const rejecting: AcpClient = {
      ...client,
      prompt: () => Promise.reject({ code: -32603, message: "Internal error", data: "session is busy" }),
    };
    const bridge = createSessionBridge({ config: CONFIG, exec, acpClient: rejecting, deathRetryMax: 0 });
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "hello" }).catch(() => {});

    const err = events.find((e) => e.type === "RUN_ERROR") as { message?: string };
    expect(err.message).toContain("session is busy");
    expect(err.message).not.toContain("[object Object]");
    await bridge.stop();
  });
});

describe("errorText", () => {
  it("renders Errors, JSON-RPC objects and primitives", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({ code: -32603, message: "Internal error" })).toBe("Internal error");
    expect(errorText({ message: "Internal error", data: { reason: "busy" } })).toBe('Internal error: {"reason":"busy"}');
    expect(errorText({ code: 7 })).toBe('{"code":7}');
    expect(errorText("plain")).toBe("plain");
  });
});
