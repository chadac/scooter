/**
 * Tier 1 contract — the model a session gets is resolved PER PROVIDER.
 *
 * Model ids are provider-specific namespaces: Bedrock ids (us.anthropic.…) via goose, API ids
 * (claude-sonnet-4-5) via the subscription SDK / the BYO container. The catalog was flat, so a
 * conversation's choice was handed to every provider verbatim — the BYO container received (and
 * silently ignored) Bedrock ids. Each run's session now gets: the conversation's choice when
 * that provider OFFERS it, else that provider's own default — never cross-namespace nonsense.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge } from "../../src/bridge.js";
import type { AcpProvider } from "../../src/acp/provider.js";
import { catalogFromEnv } from "../../src/agent/models.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";

const BRIDGE_CONFIG = {
  cwd: "/workspace",
  skillsDir: "/skills",
  agent: { command: "fake", args: [], env: {} },
  sandbox: { name: "s", namespace: "ns" },
};

const CATALOG = catalogFromEnv({
  AGENT_MODELS_JSON: JSON.stringify([
    { id: "us.anthropic.claude-sonnet-4-6", default: true, providers: ["goose"] },
    { id: "claude-sonnet-4-5", providers: ["byoc"] },
  ]),
} as never);

function sessionRecordingAgent(exec: ReturnType<typeof createSandboxExecBackend>) {
  const agent = createFakeAcpAgent();
  agent.setScript([
    { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
    { finish: { stopReason: "end_turn" } },
  ]);
  const client = acpClientFromTransport(agent.transport, exec);
  const newSessions: Array<{ model?: string }> = [];
  const wrapped = new Proxy(client, {
    get(target, prop, recv) {
      if (prop === "newSession") {
        return (params: { model?: string }) => {
          newSessions.push(params);
          return (target as unknown as { newSession: (p: unknown) => unknown }).newSession(params);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
  return { client: wrapped, newSessions };
}

describe("per-provider model resolution", () => {
  it("a Bedrock choice reaches the goose session but NOT the byoc one — which gets ITS default", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const goose = sessionRecordingAgent(exec);
    const byoc = sessionRecordingAgent(exec);

    let containerOnline = false;
    const providers: AcpProvider[] = [
      { id: "remote-personalized", kind: "claude", priority: 10, modelTag: "byoc", eligible: () => containerOnline, createClient: () => byoc.client },
      { id: "floor", kind: "goose", priority: 0, modelTag: "goose", eligible: () => true, createClient: () => goose.client },
    ];

    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG, exec, acpProviders: providers,
      model: "us.anthropic.claude-sonnet-4-6",
      modelCatalog: CATALOG,
    });

    await bridge.prompt({ threadId: "t1", text: "first", source: "ui" });
    expect(goose.newSessions[0]?.model).toBe("us.anthropic.claude-sonnet-4-6");

    containerOnline = true;
    await bridge.prompt({ threadId: "t1", text: "second", source: "ui" });
    // THE POINT: the container must never receive a Bedrock id. It gets its own default.
    expect(byoc.newSessions[0]?.model).toBe("claude-sonnet-4-5");
  });

  it("no catalog (legacy deployment) passes the conversation model through untouched", async () => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const agent = sessionRecordingAgent(exec);
    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG, exec, acpClient: agent.client, model: "anything-goes",
    });
    await bridge.prompt({ threadId: "t1", text: "hi" });
    expect(agent.newSessions[0]?.model).toBe("anything-goes");
  });
});
