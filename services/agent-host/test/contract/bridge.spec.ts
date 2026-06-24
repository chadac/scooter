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

/** Persisted events = the broadcast stream PLUS persist-only events (the user's
 *  own prompt). What the durable log / history replay sees. */
const collectPersist = (bridge: ReturnType<typeof createSessionBridge>) => {
  const events: AguiEvent[] = [];
  bridge.onEvent((e) => events.push(e));
  bridge.onPersist((e) => events.push(e));
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
    const broadcast = collect(bridge); // onEvent (UI) only
    const persisted = collectPersist(bridge); // onEvent + onPersist (the log)

    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "hi" });

    // BROADCAST (what the UI gets): NO user message — the UI already renders the
    // message it sent, so re-broadcasting it would echo a duplicate.
    expect(broadcast.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(
      (broadcast.filter((e) => e.type === "TEXT_MESSAGE_START") as Array<{ role: string }>).map(
        (s) => s.role,
      ),
    ).toEqual(["assistant"]); // no "user" on the broadcast

    // PERSISTED (history replay): the user's prompt IS in the durable log, as a
    // user message, so switching to / reviving the conversation shows it.
    const userStart = persisted.find(
      (e) => e.type === "TEXT_MESSAGE_START" && (e as { role?: string }).role === "user",
    );
    expect(userStart, "user prompt must be persisted").toBeTruthy();
    const userContent = persisted.find(
      (e): e is { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string } =>
        e.type === "TEXT_MESSAGE_CONTENT" &&
        (e as { messageId: string }).messageId === (userStart as { messageId: string }).messageId,
    );
    expect(userContent?.delta).toBe("hi");
  });

  it("blocks on a permission/option request and resolves on the user's pick", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([
      {
        requestPermission: {
          toolCallId: "perm1",
          title: "Grant S3 write to bucket acme-data?",
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Reject", kind: "reject_once" },
          ],
        },
      },
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Granted." } } },
      { finish: { stopReason: "end_turn" } },
    ]);

    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
    });
    const events = collect(bridge);
    // Answer as soon as the request is emitted (the run is blocked until then).
    bridge.onEvent((e) => {
      if (e.type === "PERMISSION_REQUEST") {
        // The request carries the options + a human-readable title.
        expect(e.title).toMatch(/S3 write/);
        expect(e.options.map((o) => o.optionId)).toEqual(["allow", "deny"]);
        bridge.answerPermission(e.toolCallId, "allow");
      }
    });

    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "grant S3 access" });

    const types = events.map((e) => e.type);
    expect(types).toContain("PERMISSION_REQUEST");
    expect(types).toContain("PERMISSION_RESOLVED");
    const resolved = events.find((e) => e.type === "PERMISSION_RESOLVED") as
      | { optionId: string | null }
      | undefined;
    expect(resolved?.optionId).toBe("allow");
    // The run continued past the (now-answered) request.
    const shown = events
      .filter((e): e is { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string } => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => e.delta)
      .join("");
    expect(shown).toContain("Granted.");
  });

  it("cancels the request when answered with an unknown option", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([
      {
        requestPermission: {
          toolCallId: "perm2",
          title: "Pick a branch",
          options: [{ optionId: "main", name: "main", kind: "allow_once" }],
        },
      },
      { finish: { stopReason: "end_turn" } },
    ]);
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
    });
    const events = collect(bridge);
    bridge.onEvent((e) => {
      if (e.type === "PERMISSION_REQUEST") {
        // A garbage optionId must not forward a bad selection — it cancels.
        const ok = bridge.answerPermission(e.toolCallId, "not-an-option");
        expect(ok).toBe(true); // the pending request WAS found
      }
    });
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "go" });

    const resolved = events.find((e) => e.type === "PERMISSION_RESOLVED") as
      | { optionId: string | null }
      | undefined;
    expect(resolved?.optionId).toBeNull(); // cancelled
  });

  it("extracts an agent-emitted <title> marker and strips it from the shown text", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([
      // The agent's first action: emit the title marker, then its real reply.
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "<title>Fix the parser</title>" } } },
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it." } } },
      { finish: { stopReason: "end_turn" } },
    ]);

    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
    });
    const titles: string[] = [];
    bridge.onTitle((t) => titles.push(t));
    const broadcast = collect(bridge);

    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "please fix the parser" });

    // The title is reported once, marker text removed.
    expect(titles).toEqual(["Fix the parser"]);
    // The displayed assistant text contains the reply but NOT the marker.
    const shown = broadcast
      .filter((e): e is { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string } => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => e.delta)
      .join("");
    expect(shown).toBe("On it.");
    expect(shown).not.toContain("<title>");
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
