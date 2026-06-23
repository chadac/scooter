/**
 * Tier 1 contract test — ACP -> AG-UI mapping (docs/DESIGN.md §4c).
 *
 * RED against the Design interfaces. Drives a fake ACP agent emitting scripted
 * session/update notifications; asserts the exact AG-UI event sequence.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge, type AguiEvent } from "../../src/bridge.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";

const collect = (bridge: ReturnType<typeof createSessionBridge>) => {
  const events: AguiEvent[] = [];
  bridge.onEvent((e) => events.push(e));
  return events;
};

describe("ACP -> AG-UI bridge", () => {
  it("maps an agent_message_chunk to TextMessage start/content/end", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } },
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } } },
      { finish: { stopReason: "end_turn" } },
    ]);

    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
    });
    const events = collect(bridge);

    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "hi" });

    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  it("maps tool_call + tool_call_update to ToolCall start/args/result", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "run ls", rawInput: { command: "ls" } } },
      { emit: { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", content: "a\nb" } },
      { finish: { stopReason: "end_turn" } },
    ]);

    const bExec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec: bExec,
      acpClient: acpClientFromTransport(agent.transport, bExec),
    });
    const events = collect(bridge);

    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "list files" });

    const types = events.map((e) => e.type);
    expect(types).toContain("TOOL_CALL_START");
    expect(types).toContain("TOOL_CALL_ARGS");
    expect(types).toContain("TOOL_CALL_RESULT");
    expect(types.indexOf("TOOL_CALL_START")).toBeLessThan(types.indexOf("TOOL_CALL_RESULT"));
  });

  it("maps plan/thoughts to Reasoning events", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } } },
      { finish: { stopReason: "end_turn" } },
    ]);
    const bExec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec: bExec,
      acpClient: acpClientFromTransport(agent.transport, bExec),
    });
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "go" });
    expect(events.map((e) => e.type)).toContain("REASONING_START");
  });

  it("emits RUN_ERROR when the agent errors", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "error" } }]);
    const bExec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec: bExec,
      acpClient: acpClientFromTransport(agent.transport, bExec),
    });
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "boom" });
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(true);
  });
});
