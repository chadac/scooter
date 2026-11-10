/**
 * Contract test for the ACP -> AG-UI mapping: a fake ACP agent emits scripted
 * session/update notifications and the exact AG-UI event sequence is asserted.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createSessionBridge,
  clarifyRunError,
  decorateSystemMessage,
  deadOnArrivalMessage,
  providerDiagnostic,
  PRIORITY_INTERRUPT,
  RESUME_AFTER_DISCONNECT,
  type AguiEvent,
} from "../../src/bridge.js";
import type { AcpClient } from "../../src/acp/client.js";
import { isOwnRun } from "../../src/session/danglingRun.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";

const collect = (bridge: ReturnType<typeof createSessionBridge>) => {
  const events: AguiEvent[] = [];
  bridge.onEvent((e) => events.push(e));
  return events;
};

/** Persisted events: the broadcast stream plus the persist-only events the durable log sees. */
const collectPersist = (bridge: ReturnType<typeof createSessionBridge>) => {
  const events: AguiEvent[] = [];
  bridge.onEvent((e) => events.push(e));
  bridge.onPersist((e) => events.push(e));
  return events;
};

describe("ACP -> AG-UI bridge", () => {
  it("mints UNIQUE run/message ids across separate bridge instances (a restart must not reuse run-1/msg-1)", async () => {
    // Ids must stay unique across bridge instances, because the UI folds by messageId and keys runs by runId.
    const idsFrom = async (): Promise<string[]> => {
      const agent = createFakeAcpAgent();
      agent.setScript([
        { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
        { finish: { stopReason: "end_turn" } },
      ]);
      const exec = createSandboxExecBackend(createFakeSandboxApi());
      const bridge = createSessionBridge({
        config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
        exec,
        acpClient: acpClientFromTransport(agent.transport, exec),
      });
      const events = collectPersist(bridge);
      await bridge.start();
      await bridge.prompt({ threadId: "t1", text: "go" });
      // Every id that keys a message/run in the log.
      return events.flatMap((e) => {
        const anyE = e as { runId?: string; messageId?: string };
        return [anyE.runId, anyE.messageId].filter((x): x is string => typeof x === "string");
      });
    };

    // Two bridges = two processes (a restart between them).
    const first = new Set(await idsFrom());
    const second = new Set(await idsFrom());
    expect(first.size).toBeGreaterThan(0);
    // No id from the first bridge is reused by the second.
    const overlap = [...second].filter((id) => first.has(id));
    expect(overlap, `ids reused across restart: ${overlap.join(", ")}`).toEqual([]);
  });

  it("surfaces a shell command from terminal/create as TOOL_CALL_ARGS (goose's shell shape)", async () => {
    // Goose's shell tool carries the command in terminal/create rather than the tool_call's rawInput, so the bridge correlates by terminalId and emits it as the tool call's args.
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const agent = createFakeAcpAgent();
    agent.gate(); // hold the run so we can interleave terminal/create + the handoff
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
    });
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "ls it" });
    await tick();

    // The tool_call carries no rawInput.
    agent.emit({ sessionUpdate: "tool_call", toolCallId: "c1", title: "run: ls -la", kind: "execute", status: "pending" } as never);
    // The command lives on terminal/create, and `sh -c "ls -la"` collapses to `ls -la`.
    agent.terminalCreated("term-1", "sh", ["-c", "ls -la"]);
    // The handoff update carrying the terminalId the bridge looks up.
    agent.emit({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "terminal", terminalId: "term-1" }] } as never);
    await tick();

    const args = events.find((e) => e.type === "TOOL_CALL_ARGS" && (e as { toolCallId?: string }).toolCallId === "c1") as
      | { delta: string }
      | undefined;
    expect(args, "no TOOL_CALL_ARGS emitted for the shell tool").toBeDefined();
    expect(JSON.parse(args!.delta)).toEqual({ command: "ls -la" });

    agent.releaseGate();
  });

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

    // The broadcast carries no user message, and the QUEUE_UPDATED snapshots covered elsewhere are filtered out here.
    expect(broadcast.filter((e) => e.type !== "QUEUE_UPDATED").map((e) => e.type)).toEqual([
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

    // The durable log does carry the user's prompt as a user message, so history replay shows it.
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

  it("pauses as an interrupt on a permission request and resumes on the user's pick", async () => {
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
    const events = collect(bridge); // broadcast (what the @ag-ui client sees)
    // PERMISSION_RESOLVED is persist-only, so it needs its own collector.
    const persisted: AguiEvent[] = [];
    bridge.onPersist((e) => persisted.push(e));
    // The request rides RUN_FINISHED's interrupt outcome; answer when it appears.
    bridge.onEvent((e) => {
      if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
        const intr = e.outcome.interrupts[0];
        expect(intr.message).toMatch(/S3 write/);
        const options = intr.metadata?.options as Array<{ optionId: string }>;
        expect(options.map((o) => o.optionId)).toEqual(["allow", "deny"]);
        bridge.answerPermission(intr.id, "allow");
      }
    });

    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "grant S3 access" });

    // The run paused with an interrupt, then resumed with a second RUN_STARTED and finished.
    const interrupt = events.find(
      (e) => e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt",
    );
    expect(interrupt).toBeTruthy();
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(2); // paused + resumed
    // PERMISSION_RESOLVED is not a standard AG-UI event and must not reach the validated broadcast stream.
    expect(events.some((e) => e.type === "PERMISSION_RESOLVED")).toBe(false);
    const resolved = persisted.find((e) => e.type === "PERMISSION_RESOLVED") as
      | { optionId: string | null }
      | undefined;
    expect(resolved?.optionId).toBe("allow");
    // The continued turn streamed past the (now-answered) request.
    const shown = events
      .filter((e): e is { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string } => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => e.delta)
      .join("");
    expect(shown).toContain("Granted.");
  });

  it("raiseInterrupt surfaces an external interrupt and fires onAnswer on the pick", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
    });
    const events = collect(bridge);

    let answered: string | null | undefined;
    // Raise an out-of-band interrupt with no goose run involved and answer it via answerPermission.
    bridge.raiseInterrupt({
      id: "aws-req-1",
      message: "Approve AWS access to dev?",
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      onAnswer: (o) => {
        answered = o;
      },
    });

    // The interrupt is emitted on the stream with the options.
    const intr = events.find((e) => e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt");
    expect(intr).toBeTruthy();
    const interrupt = (intr as { outcome: { interrupts: Array<{ id: string; metadata?: { options?: unknown } }> } }).outcome.interrupts[0];
    expect(interrupt.id).toBe("aws-req-1");

    // Answering fires onAnswer (no goose resume); a second answer is a no-op.
    expect(bridge.answerPermission("aws-req-1", "approve")).toBe(true);
    expect(answered).toBe("approve");
    expect(bridge.answerPermission("aws-req-1", "approve")).toBe(false); // already settled
  });

  it("withdrawInterrupt settles an external interrupt without firing onAnswer", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
    });
    const persisted: Array<{ type: string; toolCallId?: string; optionId?: string | null }> = [];
    bridge.onPersist((e) => persisted.push(e as never));
    const onAnswer = vi.fn();
    bridge.raiseInterrupt({
      id: "commits-p1",
      message: "Use Ada <ada@x.dev>?",
      options: [{ optionId: "approve", name: "Approve", kind: "allow_once" }],
      onAnswer,
    });

    expect(bridge.withdrawInterrupt("commits-p1")).toBe(true);
    // The log settles the card, so every open tab drops it.
    expect(persisted).toContainEqual(expect.objectContaining({ type: "PERMISSION_RESOLVED", toolCallId: "commits-p1", optionId: null }));
    expect(onAnswer).not.toHaveBeenCalled();
    // Gone: a late click and a second withdraw both find nothing.
    expect(bridge.answerPermission("commits-p1", "approve")).toBe(false);
    expect(bridge.withdrawInterrupt("commits-p1")).toBe(false);
  });

  it("raiseInterrupt merges extra metadata (e.g. aws:true) alongside options", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
    });
    const events = collect(bridge);

    bridge.raiseInterrupt({
      id: "aws-req-2",
      message: "Approve AWS access to dev?",
      options: [{ optionId: "approve", name: "Approve", kind: "allow_once" }],
      // The AWS tag the UI keys on to run its per-viewer can-approve check.
      metadata: { aws: true, requestId: "aws-req-2" },
      onAnswer: () => {},
    });

    const intr = events.find((e) => e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt");
    const meta = (intr as { outcome: { interrupts: Array<{ metadata?: Record<string, unknown> }> } })
      .outcome.interrupts[0].metadata;
    // Both the extra metadata and the options survive the merge.
    expect(meta?.aws).toBe(true);
    expect(meta?.requestId).toBe("aws-req-2");
    expect(Array.isArray(meta?.options)).toBe(true);
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
    const persisted: AguiEvent[] = [];
    bridge.onPersist((e) => persisted.push(e));
    bridge.onEvent((e) => {
      if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
        // A garbage optionId must not forward a bad selection — it cancels.
        const ok = bridge.answerPermission(e.outcome.interrupts[0].id, "not-an-option");
        expect(ok).toBe(true); // the pending request WAS found
      }
    });
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "go" });

    const resolved = persisted.find((e) => e.type === "PERMISSION_RESOLVED") as
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
    // The displayed assistant text contains the reply without the marker.
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

  it("emits TOOL_CALL_RESULT when the result rides rawOutput (the claude-sdk path)", async () => {
    // The claude-sdk provider puts a tool_result's content in rawOutput rather than content, and the bridge must treat it as real result content.
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "tool_call", toolCallId: "e1", title: "marimo_embed", rawInput: { code: "mo.md('hi')" } } },
      // Completed with no content: the result rides rawOutput.
      { emit: { sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", rawOutput: "```marimo-embed\nBASE64\n```" } },
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
    await bridge.prompt({ threadId: "t1", text: "embed something" });

    const result = events.find((e) => e.type === "TOOL_CALL_RESULT") as { content: string } | undefined;
    expect(result).toBeDefined();
    // The rawOutput content reached the UI verbatim (the island fence).
    expect(result?.content).toContain("marimo-embed");
    expect(result?.content).toContain("BASE64");
  });

  it("emits TOOL_CALL_ARGS from the tool_call_update when the initial tool_call had no rawInput", async () => {
    // Goose's tool_call arrives with no rawInput and the real args come on a later tool_call_update, which must still surface exactly once.
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "tool_call", toolCallId: "tc9", title: "Shell" } }, // no rawInput
      { emit: { sessionUpdate: "tool_call_update", toolCallId: "tc9", status: "in_progress", rawInput: { command: "echo hi" } } },
      { emit: { sessionUpdate: "tool_call_update", toolCallId: "tc9", status: "completed", content: "hi", rawInput: { command: "echo hi" } } },
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
    await bridge.prompt({ threadId: "t1", text: "run it" });

    const args = events.filter((e) => e.type === "TOOL_CALL_ARGS") as Array<{ toolCallId: string; delta: string }>;
    // Exactly one args event, carrying the command.
    expect(args).toHaveLength(1);
    expect(args[0].toolCallId).toBe("tc9");
    expect(args[0].delta).toContain("echo hi");

    // Exactly one result, from the completed update and after the args, so a still-running tool does not render as complete.
    const results = events.filter((e) => e.type === "TOOL_CALL_RESULT") as Array<{ toolCallId: string; content: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("tc9");
    expect(results[0].content).toContain("hi");
  });

  it("a TERMINAL HANDOFF update does NOT complete the tool call — only the later finish does", async () => {
    // Goose's shell tool marks the terminal-handoff update completed while the command still runs, so only the final update may produce the single TOOL_CALL_RESULT.
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "tool_call", toolCallId: "sh1", title: "Shell" } },
      { emit: { sessionUpdate: "tool_call_update", toolCallId: "sh1", status: "completed" } },
      { emit: { sessionUpdate: "tool_call_update", toolCallId: "sh1", status: "completed", content: [{ terminalId: "term-1", type: "terminal" }] } },
      { emit: { sessionUpdate: "tool_call_update", toolCallId: "sh1", status: "completed" } }, // the real finish (command done)
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
    await bridge.prompt({ threadId: "t1", text: "run sleep" });

    // Exactly one result, because the terminal handoff does not count as the finish.
    const results = events.filter((e) => e.type === "TOOL_CALL_RESULT");
    expect(results).toHaveLength(1);
    // The result comes after the start.
    const types = events.map((e) => e.type);
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

  it("serializes concurrent prompts — no RUN_FINISHED with a text message still open", async () => {
    // Two overlapping prompts must produce two well-formed runs, one after the other.
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply" } } },
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

    // Fire two prompts without awaiting the first so they overlap.
    const p1 = bridge.prompt({ threadId: "t1", text: "first" });
    const p2 = bridge.prompt({ threadId: "t1", text: "second" });
    await Promise.all([p1, p2]);

    // Every RUN_FINISHED is emitted with no text message open.
    const open = new Set<string>();
    for (const e of events) {
      if (e.type === "TEXT_MESSAGE_START") open.add(e.messageId);
      else if (e.type === "TEXT_MESSAGE_END") open.delete(e.messageId);
      else if (e.type === "RUN_FINISHED") {
        expect(open.size, `RUN_FINISHED while text open: ${[...open]}`).toBe(0);
      }
    }
    // Both runs actually ran.
    expect(events.filter((e) => e.type === "RUN_STARTED")).toHaveLength(2);
    expect(events.filter((e) => e.type === "RUN_FINISHED")).toHaveLength(2);
  });
});

describe("revive history reinjection", () => {
  // An ACP client that records the prompt ContentBlock[] of every prompt() call, emits nothing and ends the turn.
  function recordingClient() {
    const prompts: Array<Array<{ type: string; text?: string }>> = [];
    const client: AcpClient = {
      async initialize() {
        return { protocolVersion: 1 };
      },
      async newSession() {
        return { sessionId: "sess-1" };
      },
      async prompt(params) {
        prompts.push(params.prompt as Array<{ type: string; text?: string }>);
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      onSessionUpdate() {
        return () => {};
      },
      onTerminalCreated() {
        return () => {};
      },
      onPermissionRequest() {},
      isAlive: () => true,
      async close() {},
    };
    return { client, prompts };
  }

  const priorLog: AguiEvent[] = [
    { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "add a readme" },
    { type: "TEXT_MESSAGE_END", messageId: "u1" },
    { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "done, added README.md" },
    { type: "TEXT_MESSAGE_END", messageId: "a1" },
  ];

  const makeBridge = (loadHistory?: () => Promise<AguiEvent[]>) => {
    const { client, prompts } = recordingClient();
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: client,
      loadHistory,
    });
    return { bridge, prompts };
  };

  it("prepends the persisted transcript to the FIRST prompt after a revive", async () => {
    const { bridge, prompts } = makeBridge(async () => priorLog);
    await bridge.prompt({ threadId: "t1", text: "now add a license" });

    // Two content blocks: [history preamble, the user's actual message].
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toHaveLength(2);
    expect(prompts[0][0].text).toContain("User: add a readme");
    expect(prompts[0][0].text).toContain("Assistant: done, added README.md");
    expect(prompts[0][1].text).toBe("now add a license"); // the raw current message, unprefixed
  });

  it("does NOT re-inject on the SECOND prompt of the same session", async () => {
    const { bridge, prompts } = makeBridge(async () => priorLog);
    await bridge.prompt({ threadId: "t1", text: "first" });
    await bridge.prompt({ threadId: "t1", text: "second" });

    expect(prompts[0]).toHaveLength(2); // first: history + message
    expect(prompts[1]).toHaveLength(1); // second: just the message (goose remembers within the session)
    expect(prompts[1][0].text).toBe("second");
  });

  it("sends only the message when there's no history provider (fresh conversation)", async () => {
    const { bridge, prompts } = makeBridge(undefined);
    await bridge.prompt({ threadId: "t1", text: "hello" });
    expect(prompts[0]).toHaveLength(1);
    expect(prompts[0][0].text).toBe("hello");
  });

  it("persists the RAW user message (not the history-prefixed prompt) so it can't fold into itself", async () => {
    const { client } = recordingClient();
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: client,
      loadHistory: async () => priorLog,
    });
    const persisted: AguiEvent[] = [];
    bridge.onPersist((e) => persisted.push(e));

    await bridge.prompt({ threadId: "t1", text: "the new message" });

    const userStart = persisted.find(
      (e) => e.type === "TEXT_MESSAGE_START" && (e as { role?: string }).role === "user",
    ) as { messageId: string } | undefined;
    const userContent = persisted.find(
      (e): e is { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string } =>
        e.type === "TEXT_MESSAGE_CONTENT" && (e as { messageId: string }).messageId === userStart?.messageId,
    );
    expect(userContent?.delta).toBe("the new message"); // raw, no preamble folded in
  });
});

describe("system messages (platform-injected, non-human)", () => {
  function recordingClient() {
    const prompts: Array<Array<{ type: string; text?: string }>> = [];
    const client: AcpClient = {
      async initialize() { return { protocolVersion: 1 }; },
      async newSession() { return { sessionId: "sess-1" }; },
      async prompt(params) {
        prompts.push(params.prompt as Array<{ type: string; text?: string }>);
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      onSessionUpdate() { return () => {}; },
      onTerminalCreated() { return () => {}; },
      onPermissionRequest() {},
      isAlive: () => true,
      async close() {},
    };
    return { client, prompts };
  }

  const makeBridge = () => {
    const { client, prompts } = recordingClient();
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: client,
    });
    return { bridge, prompts };
  };

  it("decorateSystemMessage frames a relayed source as the user speaking", () => {
    const out = decorateSystemMessage("vscode", "fix the build");
    expect(out).toBe("[The user typed this in vscode.]\n\nfix the build");
  });

  it("decorateSystemMessage brackets the source + tells the agent not to reply just to ack", () => {
    const out = decorateSystemMessage("github", "PR #4 was labeled");
    expect(out).toContain("System message from github");
    expect(out).toContain("do NOT reply to the user just to acknowledge");
    expect(out).toContain("PR #4 was labeled");
  });

  it("persists a SYSTEM_MESSAGE event (NOT a user TEXT_MESSAGE) so the UI folds it out of the thread", async () => {
    const { bridge } = makeBridge();
    const persisted: AguiEvent[] = [];
    bridge.onPersist((e) => persisted.push(e));

    await bridge.prompt({ threadId: "t1", text: "a github event", source: "github" });

    const sys = persisted.find((e) => e.type === "SYSTEM_MESSAGE") as
      | { type: "SYSTEM_MESSAGE"; source: string; text: string }
      | undefined;
    expect(sys, "a system-sourced prompt must persist a SYSTEM_MESSAGE").toBeDefined();
    expect(sys?.source).toBe("github");
    expect(sys?.text).toBe("a github event");
    // It must not also appear as a normal user text message.
    const userStart = persisted.find(
      (e) => e.type === "TEXT_MESSAGE_START" && (e as { role?: string }).role === "user",
    );
    expect(userStart, "system message must not persist as a user turn").toBeUndefined();
  });

  it("records the sender's identity and level on the SYSTEM_MESSAGE, and only there", async () => {
    const { bridge, prompts } = makeBridge();
    const persisted: AguiEvent[] = [];
    bridge.onPersist((e) => persisted.push(e));

    await bridge.prompt({ threadId: "t1", text: "a comment", source: "github", sender: { id: "ident-1", level: 80 } });

    const sys = persisted.find((e) => e.type === "SYSTEM_MESSAGE") as { sender?: string; level?: number } | undefined;
    expect(sys?.sender).toBe("ident-1");
    expect(sys?.level).toBe(80);
    // The sender is platform state, not prompt text.
    expect(prompts[0][0].text).toBe(decorateSystemMessage("github", "a comment"));
  });

  it("a sourced prompt with no sender persists no sender fields", async () => {
    const { bridge } = makeBridge();
    const persisted: AguiEvent[] = [];
    bridge.onPersist((e) => persisted.push(e));
    await bridge.prompt({ threadId: "t1", text: "a schedule fired", source: "scheduler" });
    const sys = persisted.find((e) => e.type === "SYSTEM_MESSAGE") as Record<string, unknown> | undefined;
    expect(sys).toBeDefined();
    expect("sender" in sys!).toBe(false);
    expect("level" in sys!).toBe(false);
  });

  it("SENDS the decorated text to the agent (the agent still acts on it)", async () => {
    const { bridge, prompts } = makeBridge();
    await bridge.prompt({ threadId: "t1", text: "a github event", source: "github" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0][0].text).toBe(decorateSystemMessage("github", "a github event"));
  });

  it("a normal (human) prompt is unaffected — no source, no decoration, persists as a user turn", async () => {
    const { bridge, prompts } = makeBridge();
    const persisted: AguiEvent[] = [];
    bridge.onPersist((e) => persisted.push(e));

    await bridge.prompt({ threadId: "t1", text: "hello there" });

    expect(prompts[0][0].text).toBe("hello there"); // raw, undecorated
    expect(persisted.some((e) => e.type === "SYSTEM_MESSAGE")).toBe(false);
    expect(
      persisted.some((e) => e.type === "TEXT_MESSAGE_START" && (e as { role?: string }).role === "user"),
    ).toBe(true);
  });
});

describe("bridge run queue + cancel", () => {
  const mkBridge = (agent: ReturnType<typeof createFakeAcpAgent>, priorityInterruptMs?: number) => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    return createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
      priorityInterruptMs,
    });
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("runs a PRIORITY prompt ahead of queued normal prompts", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate(); // hold the first run in flight so the others queue behind it
    const bridge = mkBridge(agent);
    const order: string[] = [];
    const events = collect(bridge);
    // Tag each run's user turn so we can read the execution order from the log.
    bridge.onPersist((e) => {
      if (e.type === "TEXT_MESSAGE_CONTENT" && (e as { delta?: string }).delta) {
        order.push((e as { delta: string }).delta);
      }
    });

    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "first (running)" });
    await tick();
    // While the first run is gated, queue a normal then a priority prompt.
    void bridge.prompt({ threadId: "t1", text: "normal" }, { priority: 0 });
    void bridge.prompt({ threadId: "t1", text: "priority" }, { priority: 10, interrupt: "timeout" });
    await tick();
    expect(bridge.queueState().queued).toBe(2);
    expect(bridge.queueState().maxQueuedPriority).toBe(10);

    agent.releaseGate(); // let the queue drain
    await tick();
    await tick();
    await tick();
    // The priority prompt ran before the earlier-queued normal one.
    expect(order[0]).toBe("first (running)");
    expect(order.indexOf("priority")).toBeLessThan(order.indexOf("normal"));
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(3);
  });

  it("emits a QUEUE_UPDATED snapshot when a prompt queues behind an active run, and drains it to empty", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate(); // hold the first run in flight so the next prompt queues behind it
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    const queueSnaps = () =>
      events.filter((e) => e.type === "QUEUE_UPDATED") as Array<{
        type: "QUEUE_UPDATED";
        items: Array<{ id: string; text: string; priority: number }>;
      }>;

    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "first (running)" });
    await tick();
    // While the first run is gated, a second prompt queues behind it.
    void bridge.prompt({ threadId: "t1", text: "queued msg" });
    await tick();

    // A snapshot showing the queued message is on the stream, which the integrity path replays on refresh.
    const withItem = queueSnaps().find((s) => s.items.some((i) => i.text === "queued msg"));
    expect(withItem).toBeDefined();
    expect(withItem!.items.map((i) => i.text)).toContain("queued msg");

    agent.releaseGate(); // let the queue drain
    await tick();
    await tick();
    await tick();

    // The last snapshot is empty because the queue drained, so the UI clears its queued list.
    const snaps = queueSnaps();
    expect(snaps.at(-1)!.items).toEqual([]);
  });

  it("tags a queued platform-injected prompt with its source in the QUEUE_UPDATED snapshot", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate();
    const bridge = mkBridge(agent);
    const events = collect(bridge);

    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "first (running)" });
    await tick();
    void bridge.prompt({ threadId: "t1", text: "webhook event", source: "github" });
    void bridge.prompt({ threadId: "t1", text: "user msg" });
    await tick();

    const snap = (events.filter((e) => e.type === "QUEUE_UPDATED") as Array<{
      items: Array<{ text: string; source?: string }>;
    }>).at(-1)!;
    // The UI renders a sourced item as a collapsed system line; a user item carries no source.
    expect(snap.items.find((i) => i.text === "webhook event")?.source).toBe("github");
    expect(snap.items.find((i) => i.text === "user msg")).not.toHaveProperty("source");

    agent.releaseGate();
    await tick();
    await tick();
    await tick();
  });

  it("tags a queued priority prompt with its interrupt policy in the QUEUE_UPDATED snapshot", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate();
    const bridge = mkBridge(agent);
    const events = collect(bridge);

    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "first (running)" });
    await tick();
    // "timeout" with the fallback disabled queues without preempting the gated run.
    void bridge.prompt({ threadId: "t1", text: "urgent" }, { priority: PRIORITY_INTERRUPT, interrupt: "timeout" });
    void bridge.prompt({ threadId: "t1", text: "normal" });
    await tick();

    const snap = (events.filter((e) => e.type === "QUEUE_UPDATED") as Array<{
      items: Array<{ text: string; interrupt?: string }>;
    }>).at(-1)!;
    // The UI tells a tool-killing interrupt apart from one that waits for tools.
    expect(snap.items.find((i) => i.text === "urgent")?.interrupt).toBe("timeout");
    expect(snap.items.find((i) => i.text === "normal")).not.toHaveProperty("interrupt");

    agent.releaseGate();
    await tick();
    await tick();
    await tick();
  });

  it("shouldYieldToQueue() is true when a PRIORITY_INTERRUPT item is queued, false for a normal/empty queue", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate(); // hold the first run in flight so later prompts queue behind it
    const bridge = mkBridge(agent);

    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "running turn" });
    await tick();
    expect(bridge.shouldYieldToQueue()).toBe(false); // nothing queued yet

    // A normal queued prompt does not trigger a yield.
    void bridge.prompt({ threadId: "t1", text: "normal follow-up" });
    await tick();
    expect(bridge.shouldYieldToQueue()).toBe(false);

    // A PRIORITY_INTERRUPT item does, checked before the next microtask lets the pump promote it out of the queue.
    void bridge.prompt({ threadId: "t1", text: "subagent result" }, { priority: PRIORITY_INTERRUPT, interrupt: "thinking" });
    expect(bridge.shouldYieldToQueue()).toBe(true);

    agent.releaseGate();
    await tick();
  });

  it("BATCHES a burst of queued same-tier messages into ONE run (not one-at-a-time)", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate(); // hold the first run so the burst queues behind it
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    const userTexts: string[] = [];
    bridge.onPersist((e) => {
      if (e.type === "TEXT_MESSAGE_START" && (e as { role?: string }).role === "user") userTexts.push("");
      if (e.type === "TEXT_MESSAGE_CONTENT" && userTexts.length) {
        userTexts[userTexts.length - 1] += (e as { delta?: string }).delta ?? "";
      }
    });

    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "first (running)" });
    await tick();
    // Three messages fired while the first run is in flight all queue at the normal tier and must coalesce into one follow-up run.
    void bridge.prompt({ threadId: "t1", text: "msg A" });
    void bridge.prompt({ threadId: "t1", text: "msg B" });
    void bridge.prompt({ threadId: "t1", text: "msg C" });
    await tick();
    expect(bridge.queueState().queued).toBe(3);

    agent.releaseGate();
    await tick();
    await tick();
    await tick();

    // Two runs total: the gated first one, then one batched run for A+B+C.
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(2);
    // Each original message is still persisted as its own user message.
    expect(userTexts).toContain("msg A");
    expect(userTexts).toContain("msg B");
    expect(userTexts).toContain("msg C");
  });

  it("does NOT batch across priority tiers (a priority @mention stays its own run)", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate();
    const bridge = mkBridge(agent);
    const events = collect(bridge);

    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "first (running)" });
    await tick();
    void bridge.prompt({ threadId: "t1", text: "normal 1" }, { priority: 0 });
    void bridge.prompt({ threadId: "t1", text: "normal 2" }, { priority: 0 });
    void bridge.prompt({ threadId: "t1", text: "priority" }, { priority: 10 });
    await tick();

    agent.releaseGate();
    await tick();
    await tick();
    await tick();

    // Three runs: the gated first, the priority one, and the two normals batched into one.
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(3);
  });

  it("cancel() ends the running turn as RUN_FINISHED{cancelled} and kills the active tool call", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate();
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "do a long thing" });
    await tick();
    expect(bridge.queueState().running).toBe(true);

    await bridge.cancel();
    await tick();

    // Killed the active terminal + told goose to stop.
    expect(agent.killCount()).toBe(1);
    // The run ended as a cancelled RUN_FINISHED, not a RUN_ERROR.
    const fin = events.find((e) => e.type === "RUN_FINISHED") as { cancelled?: boolean } | undefined;
    expect(fin).toBeTruthy();
    expect(fin?.cancelled).toBe(true);
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);
  });

  it("cancel() is a no-op when nothing is running", async () => {
    const agent = createFakeAcpAgent();
    const bridge = mkBridge(agent);
    await bridge.start();
    await bridge.cancel(); // must not throw
    expect(agent.killCount()).toBe(0);
    expect(bridge.queueState().running).toBe(false);
  });

  it("force-interrupts the running turn when a PRIORITY item waits past the timeout", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate(); // the running turn never finishes on its own
    const bridge = mkBridge(agent, 20); // 20ms priority-interrupt timeout
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "long running turn" });
    await tick();
    // A priority (mention) prompt queues behind the stuck run.
    void bridge.prompt({ threadId: "t1", text: "@scooter urgent" }, { priority: 10, interrupt: "timeout" });
    // Wait past the timeout — the force-interrupt should fire.
    await new Promise((r) => setTimeout(r, 60));
    agent.releaseGate();
    await tick();
    await tick();

    // The first run was force-cancelled (killed) so the priority item could run.
    expect(agent.killCount()).toBeGreaterThanOrEqual(1);
    const finishes = events.filter((e) => e.type === "RUN_FINISHED") as Array<{ cancelled?: boolean }>;
    expect(finishes.some((f) => f.cancelled === true)).toBe(true);
    // Both runs started (the interrupted one + the priority takeover).
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(2);
  });

  // --- graduated interrupt levels (tool-call / thinking / timeout) -------------

  it('interrupt "tool-call" cancels IMMEDIATELY (kills the running tool call)', async () => {
    const agent = createFakeAcpAgent();
    // Emit a tool_call, then gate so the run hangs mid-tool.
    agent.setScript([
      { emit: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "run: sleep 999" } as never },
      { finish: { stopReason: "end_turn" } },
    ]);
    agent.gate();
    const bridge = mkBridge(agent); // no timeout configured — tool-call preempts regardless
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "long tool" });
    await tick();

    // A tool-call-level priority prompt preempts now, even with a tool running.
    void bridge.prompt({ threadId: "t1", text: "stop now" }, { priority: 10, interrupt: "tool-call" });
    await tick();
    await tick();

    expect(agent.killCount()).toBeGreaterThanOrEqual(1); // the running tool was killed
    const fin = events.find((e) => e.type === "RUN_FINISHED") as { cancelled?: boolean } | undefined;
    expect(fin?.cancelled).toBe(true);
  });

  it('interrupt "thinking" DEFERS while a tool call is in flight, then fires at the tool boundary', async () => {
    const agent = createFakeAcpAgent();
    // A tool call starts and the run gates before the tool's result.
    agent.setScript([
      { emit: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "run: build" } as never },
      { finish: { stopReason: "end_turn" } },
    ]);
    agent.gate();
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "building" });
    await tick();

    // A thinking-level priority prompt arriving while a tool is in flight must not cancel yet.
    void bridge.prompt({ threadId: "t1", text: "job done" }, { priority: 10, interrupt: "thinking" });
    await tick();
    await tick();
    expect(agent.killCount()).toBe(0); // deferred — tool call still running, not killed
    const finishedYet = events.some((e) => e.type === "RUN_FINISHED" && (e as { cancelled?: boolean }).cancelled);
    expect(finishedYet).toBe(false);

    // The tool call completes (its result update) → the deferred cancel fires now.
    agent.emit({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", content: "ok" } as never);
    await tick();
    await tick();
    expect(agent.killCount()).toBeGreaterThanOrEqual(1); // cancelled at the tool boundary
  });

  it('interrupt "thinking" ESCALATES to a hard cancel if the tool call never yields (timeout fallback)', async () => {
    // With priorityInterruptMs set, a deferred "thinking" interrupt hard-cancels after the timeout when the tool never finishes.
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "run: sleep 3600" } as never },
      { finish: { stopReason: "end_turn" } },
    ]);
    agent.gate();
    const bridge = mkBridge(agent, 20); // 20ms fallback
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "sleeping" });
    await tick();

    // "thinking" priority arrives while the (never-completing) tool is in flight.
    void bridge.prompt({ threadId: "t1", text: "cancel that" }, { priority: 10, interrupt: "thinking" });
    // The tool never emits a result, so waiting past the fallback timeout must trigger the hard cancel.
    await new Promise((r) => setTimeout(r, 60));
    agent.releaseGate();
    await tick();
    await tick();
    expect(agent.killCount()).toBeGreaterThanOrEqual(1); // hard-cancelled by the fallback
    const finishes = events.filter((e) => e.type === "RUN_FINISHED") as Array<{ cancelled?: boolean }>;
    expect(finishes.some((f) => f.cancelled === true)).toBe(true);
  });

  it('interrupt "thinking" cancels IMMEDIATELY when NO tool call is in flight (idle thinking)', async () => {
    const agent = createFakeAcpAgent();
    // No tool call: the run is gated with nothing in flight.
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate();
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "thinking..." });
    await tick();

    void bridge.prompt({ threadId: "t1", text: "job done" }, { priority: 10, interrupt: "thinking" });
    await tick();
    await tick();

    // No tool in flight → preempt now.
    const fin = events.find((e) => e.type === "RUN_FINISHED") as { cancelled?: boolean } | undefined;
    expect(fin?.cancelled).toBe(true);
  });

  it('interrupt "thinking" WAITS for a run still in setup to send its prompt', async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate();
    // Hold the first run in setup (before its send) on the history load.
    let releaseHistory!: () => void;
    const historyLoaded = new Promise<void>((r) => (releaseHistory = r));
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const bridge = createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
      loadHistory: async () => {
        await historyLoaded;
        return [];
      },
    });
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "first" });
    await tick();

    void bridge.prompt({ threadId: "t1", text: "second" }, { priority: 10, interrupt: "thinking" });
    await tick();
    // Not aborted in setup: the first run is still alive, its prompt unsent.
    expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(false);
    expect(agent.startedCount()).toBe(0);

    // Once the first prompt reaches the agent, the deferred interrupt cancels it.
    releaseHistory();
    await tick();
    await tick();
    expect(agent.startedCount()).toBeGreaterThanOrEqual(1);
    const fin = events.find((e) => e.type === "RUN_FINISHED") as { cancelled?: boolean } | undefined;
    expect(fin?.cancelled).toBe(true);
  });

  it('a priority prompt with no policy defaults to "thinking" (waits for tool, then preempts)', async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "run: build" } as never },
      { finish: { stopReason: "end_turn" } },
    ]);
    agent.gate();
    const bridge = mkBridge(agent); // no timeout fallback, as in production
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "building" });
    await tick();

    // A replayed queue item carries only its priority, no interrupt policy.
    void bridge.prompt({ threadId: "t1", text: "slack reply" }, { priority: PRIORITY_INTERRUPT });
    await tick();
    expect(agent.killCount()).toBe(0);

    agent.emit({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", content: "ok" } as never);
    await tick();
    await tick();
    const fin = events.find((e) => e.type === "RUN_FINISHED") as { cancelled?: boolean } | undefined;
    expect(fin?.cancelled).toBe(true);
  });

  // --- suspend / revive teardown of the queue ----------------------------------
  // suspend() drops the whole bridge closure with its queue and revive() builds a
  // fresh one, so stop() must settle every queued prompt's promise and leave an
  // empty QUEUE_UPDATED as the log's last snapshot. Preserving the message itself
  // is the manager's job, covered in suspendedRevive.spec.ts.

  it("stop() SETTLES queued prompts instead of abandoning their promises", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate(); // hold the first run so the second prompt queues behind it
    const bridge = mkBridge(agent);
    await bridge.start();

    // The running prompt is not rejected by drainQueue, but the gated fake never finishes it, so catch to avoid leaking a pending promise.
    void bridge.prompt({ threadId: "t1", text: "running" }).catch(() => {});
    await tick();

    // This one is queued behind the gated run when the suspend lands.
    let settled: "resolved" | "rejected" | "pending" = "pending";
    const queued = bridge
      .prompt({ threadId: "t1", text: "queued at suspend" })
      .then(() => { settled = "resolved"; })
      .catch(() => { settled = "rejected"; });
    await tick();

    // Suspend tears the bridge down (manager.suspend calls bridge.stop() then drops it).
    await bridge.stop();
    await tick();
    await tick();

    // The queued item can never run, so its promise has to settle.
    await Promise.race([queued, tick().then(() => tick())]);
    expect(
      settled,
      "a prompt queued when the bridge was torn down must settle, not leak forever",
    ).not.toBe("pending");
  });

  it("drainQueue() captures the IN-FLIGHT batch, not just what's still waiting", async () => {
    // The pump splices the running batch out of `queue`, so a mid-run suspend must capture the in-flight message too.
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate(); // hold the first prompt in flight as the running batch
    const bridge = mkBridge(agent);
    await bridge.start();

    const inFlight = bridge.prompt({ threadId: "t1", text: "in flight when suspended" });
    await tick(); // let the pump pick it up (spliced out of `queue`, now running)

    let rejected = false;
    void inFlight.catch(() => { rejected = true; });

    const drained = bridge.drainQueue();
    expect(
      drained.map((d) => d.text),
      "a message the pump is RUNNING must be preserved by a mid-run suspend",
    ).toContain("in flight when suspended");

    await tick();
    // An in-flight item is a run already executing and the pump settles it, so it must not be rejected here.
    expect(rejected, "drainQueue must not reject an ALREADY-RUNNING prompt").toBe(false);
  });

  it("drainQueue() keeps each message's sender, so a revived conversation still knows who sent it", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate();
    const bridge = mkBridge(agent);
    await bridge.start();

    void bridge.prompt({ threadId: "t1", text: "running", source: "github", sender: { id: "ident-a", level: 40 } }).catch(() => {});
    await tick();
    void bridge.prompt({ threadId: "t1", text: "queued", source: "github", sender: { id: "ident-b", level: 80 } }).catch(() => {});
    await tick();

    const drained = bridge.drainQueue();
    expect(drained.map((d) => d.sender)).toEqual([{ id: "ident-a", level: 40 }, { id: "ident-b", level: 80 }]);
  });

  it("stop() emits a CLEARING queue snapshot so a revived tab shows no phantom queue", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.gate();
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await bridge.start();

    // stop() rejects abandoned queue items, so attach catch handlers to avoid unhandled rejections.
    void bridge.prompt({ threadId: "t1", text: "running" }).catch(() => {});
    await tick();
    void bridge.prompt({ threadId: "t1", text: "phantom queued msg" }).catch(() => {});
    await tick();

    const snaps = () =>
      events.filter((e) => e.type === "QUEUE_UPDATED") as Array<{
        type: "QUEUE_UPDATED";
        items: Array<{ id: string; text: string; priority: number }>;
      }>;
    // Precondition: the queued message is in the latest snapshot.
    expect(snaps().at(-1)!.items.map((i) => i.text)).toContain("phantom queued msg");

    await bridge.stop();
    await tick();

    // The log's last queue snapshot must be empty, or a UI reattaching after the revive renders a queued bubble no pump will drain.
    expect(
      snaps().at(-1)!.items,
      "a torn-down bridge must leave an EMPTY queue snapshot, not a stale one",
    ).toEqual([]);
  });

});

describe("bridge dead-on-arrival watchdog (firstActivityTimeoutMs)", () => {
  const mkBridge = (
    agent: ReturnType<typeof createFakeAcpAgent>,
    firstActivityTimeoutMs: number,
    // The agent subprocess's stderr tail, where the provider writes the diagnostic for a run that produced nothing.
    stderr?: string[],
    retry?: { deathRetryMax: number; deathRetryBaseMs: number },
  ) => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    const client = acpClientFromTransport(agent.transport, exec);
    return createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: stderr ? { ...client, recentDiagnostics: () => stderr } : client,
      firstActivityTimeoutMs,
      ...(retry ?? {}),
    });
  };
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

  it("fires RUN_ERROR when a run emits NO ACP activity within the timeout (dead-on-arrival hang)", async () => {
    const agent = createFakeAcpAgent();
    // An empty script plus a gate: prompt() emits nothing and hangs.
    agent.setScript([]);
    agent.gate();
    const bridge = mkBridge(agent, 30); // 30ms so the test is fast
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "hello?" });

    // RUN_STARTED emits immediately; then no activity → watchdog fires.
    await tick(60);
    const started = events.filter((e) => e.type === "RUN_STARTED");
    const runError = events.find((e) => e.type === "RUN_ERROR") as { code?: string; message?: string } | undefined;
    expect(started.length).toBe(1);
    expect(runError).toBeDefined();
    expect(runError!.code).toBe("no_activity_timeout");
    // Exactly one terminal event: the watchdog's cancel resolves the gated prompt(), but st.terminated suppresses a second one.
    const terminals = events.filter((e) => e.type === "RUN_ERROR" || e.type === "RUN_FINISHED");
    expect(terminals.length).toBe(1);
  });

  it("does NOT blame credentials for a dead-on-arrival run — it names the candidates", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([]);
    agent.gate();
    const bridge = mkBridge(agent, 30);
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "hello?" });
    await tick(60);

    const message = (events.find((e) => e.type === "RUN_ERROR") as { message?: string }).message ?? "";
    expect(message).not.toMatch(/usually means a model\/credential error/i);
    expect(message).toMatch(/skew/i); // version skew is named as a candidate
    expect(message).toMatch(/credential/i); // …and so is the credential case
  });

  it("surfaces the provider's own diagnostic in the dead-on-arrival error", async () => {
    // The `[ede_diagnostic]` line exists only on the provider subprocess's stderr, since ACP reports nothing for a run that never spoke.
    const agent = createFakeAcpAgent();
    agent.setScript([]);
    agent.gate();
    const bridge = mkBridge(agent, 30, [
      "[sdk] prompt: query start, model=claude-opus-5",
      "[sdk] prompt: query stream error: Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
    ]);
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "hello?" });
    await tick(60);

    const message = (events.find((e) => e.type === "RUN_ERROR") as { message?: string }).message ?? "";
    expect(message).toContain("ede_diagnostic");
  });

  it("carries a LATE diagnostic into the next attempt's message", async () => {
    // The cause of attempt N arrives only after the watchdog gives up and the wedged session is dropped, so the bridge keeps it for attempt N+1.
    const agent = createFakeAcpAgent();
    agent.setScript([]);
    agent.gate();
    // Rejects when the watchdog's cancel releases it — after attempt 1's RUN_ERROR.
    agent.failNext("Claude Code returned an error result: [ede_diagnostic] result_type=user stop_reason=null");
    const bridge = mkBridge(agent, 30, undefined, { deathRetryMax: 1, deathRetryBaseMs: 10 });
    const events = collect(bridge);
    await bridge.start();

    void bridge.prompt({ threadId: "t1", text: "wedged" });
    await tick(250); // attempt 1 → its late rejection → the auto-retry's attempt 2

    const errors = events.filter((e) => e.type === "RUN_ERROR") as { message?: string }[];
    expect(errors.length).toBeGreaterThanOrEqual(2);
    // Attempt 1 could not name the cause — it had not happened yet.
    expect(errors[0].message ?? "").not.toContain("ede_diagnostic");
    // A later attempt can: the diagnostic outlived the client that produced it.
    expect(errors.at(-1)!.message ?? "").toContain("ede_diagnostic");
    agent.releaseGate();
    await bridge.stop();
  });

  it("picks the ede_diagnostic line out of a stderr tail, and truncates a long one", () => {
    expect(providerDiagnostic(undefined)).toBeUndefined();
    expect(providerDiagnostic(["[sdk] prompt: query start", "  "])).toBeUndefined();
    // The ede_diagnostic signature wins over a later, more generic error line.
    expect(
      providerDiagnostic(["boom: [ede_diagnostic] stop_reason=null", "some later error line"]),
    ).toContain("ede_diagnostic");
    // Without the signature the most recent error-ish line is used.
    expect(providerDiagnostic(["ok", "connect ECONNREFUSED"])).toBe("connect ECONNREFUSED");
    const long = `x [ede_diagnostic] ${"y".repeat(500)}`;
    expect(providerDiagnostic([long])!.length).toBeLessThanOrEqual(301);
    // No diagnostic → the message simply omits the clause rather than saying "undefined".
    expect(deadOnArrivalMessage()).not.toMatch(/undefined/);
  });

  it("does NOT fire when the run emits activity before the timeout (a live run is untouched)", async () => {
    const agent = createFakeAcpAgent();
    // The run streams a chunk then finishes — real activity disarms the watchdog.
    agent.setScript([
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi from the agent" } } },
      { finish: { stopReason: "end_turn" } },
    ]);
    const bridge = mkBridge(agent, 30);
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "hello?" });
    // Wait past the timeout to prove the watchdog was disarmed.
    await tick(60);

    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);
    const fin = events.filter((e) => e.type === "RUN_FINISHED");
    expect(fin.length).toBe(1); // a normal, single, clean finish
  });

  it("RETRIES a wedged run whose prompt() never settles (a stalled agent must not hold the pump)", async () => {
    // `ignoreCancel` models an agent stalled inside a model call that never answers session/cancel, so the retry must run while attempt 1's prompt() is still pending.
    const agent = createFakeAcpAgent();
    agent.setScript([]);
    agent.gate({ ignoreCancel: true });
    const bridge = mkBridge(agent, 30, undefined, { deathRetryMax: 1, deathRetryBaseMs: 10 });
    const events = collect(bridge);
    await bridge.start();

    void bridge.prompt({ threadId: "t1", text: "hello?" });
    await tick(120); // attempt 1's watchdog → backoff → attempt 2 STARTS

    expect(events.filter((e) => e.type === "RUN_ERROR").length).toBeGreaterThanOrEqual(1);
    // A second attempt was driven while attempt 1's prompt() was still pending.
    expect(events.some((e) => e.type === "RUN_RETRYING")).toBe(true);
    expect(agent.startedCount()).toBeGreaterThanOrEqual(2);
    agent.releaseGate();
    await bridge.stop();
  });

  it("does NOT fire while the run is PAUSED on a permission request that is its FIRST ACP traffic", async () => {
    const agent = createFakeAcpAgent();
    // The fake agent's "?<prompt>" directive (and goose's own tool gate on a first-turn
    // tool) asks for the choice before emitting any session/update, so the request itself
    // is this run's first and only ACP traffic — there is no update to disarm the watchdog.
    agent.setScript([
      {
        requestPermission: {
          toolCallId: "pick1",
          title: "pick a color",
          options: [
            { optionId: "red", name: "Red", kind: "allow_once" },
            { optionId: "green", name: "Green", kind: "allow_once" },
          ],
        },
      },
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "you picked: green" } } },
      { finish: { stopReason: "end_turn" } },
    ]);
    const bridge = mkBridge(agent, 30); // 30ms stands in for the 60s production window
    const events = collect(bridge);
    await bridge.start();
    const run = bridge.prompt({ threadId: "t1", text: "?pick a color" });

    // The user takes longer than the window to answer: human thinking time is not a wedge.
    await tick(120);
    const interrupt = events.find(
      (e) => e.type === "RUN_FINISHED" && (e as { outcome?: { type?: string } }).outcome?.type === "interrupt",
    );
    expect(interrupt, "the run must pause as an interrupt").toBeDefined();
    expect(events.find((e) => e.type === "RUN_ERROR"), "a paused run is not dead on arrival").toBeUndefined();

    // …and the late answer still resumes the run, rather than resolving a killed session.
    expect(bridge.answerPermission("pick1", "green")).toBe(true);
    await run;
    const shown = events
      .filter((e): e is { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string } => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => e.delta)
      .join("");
    expect(shown).toContain("you picked: green");
  });

  it("is disabled when firstActivityTimeoutMs is 0 (opt-out)", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([]);
    agent.gate();
    const bridge = mkBridge(agent, 0);
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "hello?" });
    await tick(60);
    // No watchdog → the gated run stays running, no RUN_ERROR.
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);
    agent.releaseGate();
  });
});

describe("bridge liveness watchdog (livenessProbeMs)", () => {
  const mkBridge = (agent: ReturnType<typeof createFakeAcpAgent>, livenessProbeMs: number) => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    return createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
      // The DOA watchdog is off so only the liveness probe can fire.
      firstActivityTimeoutMs: 0,
      livenessProbeMs,
    });
  };
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

  it("fires RUN_ERROR when the agent PROCESS dies mid-run (a definitive wedge)", async () => {
    const agent = createFakeAcpAgent();
    // Emit one chunk, gate so prompt() hangs, then kill the agent process so the probe observes isAlive() false and force-terminates.
    agent.setScript([
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working on it" } } },
    ]);
    agent.gate();
    const bridge = mkBridge(agent, 40); // probe every 40ms
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "do a big thing" });

    await tick(20);
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false); // alive → untouched
    agent.die(); // the goose/claude subprocess exited without a terminal event
    await tick(90); // next probe observes it

    const runError = events.find((e) => e.type === "RUN_ERROR") as { code?: string } | undefined;
    expect(runError).toBeDefined();
    expect(runError!.code).toBe("agent_process_died");
    // Exactly one terminal event: the guard's cancel resolves the gated prompt, and the terminated flag suppresses a second.
    const terminals = events.filter((e) => e.type === "RUN_ERROR" || e.type === "RUN_FINISHED");
    expect(terminals.length).toBe(1);
    agent.releaseGate();
  });

  it("does NOT fire for a LONG SILENT but ALIVE run (a long tool call is healthy, not a wedge)", async () => {
    const agent = createFakeAcpAgent();
    // One chunk then a gate models a long tool call, and silence while the agent is alive must not fire the probe.
    agent.setScript([
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "running a 10-minute build" } } },
    ]);
    agent.gate();
    const bridge = mkBridge(agent, 40);
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "build the world" });

    // Many probe cycles pass with the run silent but the agent alive.
    await tick(200);
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);
    agent.releaseGate();
  });

  it("does NOT fire while the run is PAUSED on a permission request (the agent is alive)", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I need approval" } } },
      { requestPermission: { toolCallId: "aws1", title: "Approve AWS?", options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ] } },
      { finish: { stopReason: "end_turn" } },
    ]);
    const bridge = mkBridge(agent, 40);
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "spend money" });

    await tick(200); // many probes while paused
    const interrupt = events.find((e) => e.type === "RUN_FINISHED" && (e as { outcome?: { type?: string } }).outcome?.type === "interrupt");
    expect(interrupt).toBeDefined();
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);
  });

  it("settles a PENDING permission request when the agent process dies (no dead card to answer)", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([
      {
        requestPermission: {
          toolCallId: "pick1",
          title: "pick a color",
          options: [
            { optionId: "red", name: "Red", kind: "allow_once" },
            { optionId: "green", name: "Green", kind: "allow_once" },
          ],
        },
      },
      { finish: { stopReason: "end_turn" } },
    ]);
    const bridge = mkBridge(agent, 40);
    const events = collect(bridge);
    const persisted: AguiEvent[] = [];
    bridge.onPersist((e) => persisted.push(e));
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "?pick a color" });

    await tick(20);
    expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(true); // paused on the request
    agent.die(); // the subprocess holding this request exits
    await tick(90);

    expect((events.find((e) => e.type === "RUN_ERROR") as { code?: string } | undefined)?.code).toBe(
      "agent_process_died",
    );
    // The card is settled rather than left pending, so the user cannot answer into the void.
    expect(bridge.answerPermission("pick1", "green")).toBe(false);
    const resolved = persisted.filter((e) => e.type === "PERMISSION_RESOLVED") as Array<{ optionId: string | null }>;
    expect(resolved.length).toBe(1);
    expect(resolved[0].optionId).toBe(null); // cancelled, not a pick the user never made
    // The dead run is not reopened by the teardown's own answer.
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(1);
  });

  it("is disabled when livenessProbeMs is 0 (opt-out) — even a dead agent isn't auto-terminated", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    ]);
    agent.gate();
    const bridge = mkBridge(agent, 0);
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "hello?" });
    agent.die();
    await tick(90);
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);
    agent.releaseGate();
  });
});

describe("bridge auto-retry on transient agent death (exponential backoff)", () => {
  const mkBridge = (agent: ReturnType<typeof createFakeAcpAgent>, opts: { livenessProbeMs?: number; deathRetryMax?: number } = {}) => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    return createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
      firstActivityTimeoutMs: 0,
      livenessProbeMs: opts.livenessProbeMs ?? 30,
      deathRetryMax: opts.deathRetryMax ?? 5,
      deathRetryBaseMs: 5, // tiny backoff for the test
      deathRetryCapMs: 20,
    });
  };
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

  it("RETRIES after the agent process dies, then SUCCEEDS when it heals (RUN_RETRYING then a clean finish)", async () => {
    const agent = createFakeAcpAgent();
    // Emit a chunk, gate so the prompt hangs, then die so the probe fires agent_process_died.
    agent.setScript([{ emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "start" } } }]);
    agent.gate();
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "do it" });

    await tick(15);
    agent.die();               // process crash
    await tick(60);            // liveness probe (30ms) observes it → RUN_ERROR(agent_process_died) + retryable
    // Heal the agent and give it a finishing script before the retry re-runs.
    agent.heal();
    agent.releaseGate();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    await tick(80);            // backoff (5ms·2ⁿ) + the retry run

    expect(events.some((e) => e.type === "RUN_RETRYING")).toBe(true);   // the UI-facing retry signal
    const retrying = events.find((e) => e.type === "RUN_RETRYING") as { attempt: number; max: number };
    expect(retrying.attempt).toBe(1);
    expect(retrying.max).toBe(5);
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBeGreaterThanOrEqual(2); // original + retry
    expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(true);   // the retry succeeded
    await bridge.stop();
  });

  it("does NOT drop prompts queued BEHIND the failing batch — they run after the retry resolves", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } } }]);
    agent.gate(); // hold run 1 in flight so prompt 2 queues behind it
    const bridge = mkBridge(agent);
    collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "first" });
    await tick(10);
    void bridge.prompt({ threadId: "t1", text: "second (queued behind)" }); // queued while run 1 is in flight

    agent.die();
    await tick(50); // run 1 dies → retryable
    // Heal and let everything finish: the retry of "first" and the queued "second" must both run.
    agent.heal();
    agent.releaseGate();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    await tick(100);

    // The second prompt entered the fake's prompt() despite the death.
    expect(agent.startedCount()).toBeGreaterThanOrEqual(2);
    await bridge.stop();
  });

  it("GIVES UP after deathRetryMax and lets the terminal RUN_ERROR stand (no infinite loop)", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } }]);
    agent.gate();
    const bridge = mkBridge(agent, { deathRetryMax: 2 });
    const events = collect(bridge);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "keeps dying" });
    agent.die(); // stays dead across all retries (never healed)
    await tick(250); // original + 2 retries, each with its own probe + backoff

    const retryings = events.filter((e) => e.type === "RUN_RETRYING");
    expect(retryings.length).toBe(2); // exactly deathRetryMax retries, then stop
    const errs = events.filter((e) => e.type === "RUN_ERROR") as { code?: string }[];
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs.at(-1)!.code).toBe("agent_process_died"); // the last terminal is the death error
    agent.releaseGate();
    await bridge.stop();
  });

  it("does NOT replay a turn that already started working when its prompt rejects (no duplicate user message)", async () => {
    // A BYOC container interrupting a resumed session mid-turn: replaying the batch would re-send the user's message on top of work the first attempt already did.
    const agent = createFakeAcpAgent();
    agent.setScript([{ emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "committing…" } } }]);
    agent.failNext("Claude Code process aborted by user");
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "From nixpkgs" });
    await tick(40);

    expect(events.some((e) => e.type === "RUN_RETRYING")).toBe(false);
    expect(agent.startedCount()).toBe(1); // the message reached the agent exactly once
    const err = events.find((e) => e.type === "RUN_ERROR") as { message?: string } | undefined;
    expect(err?.message).toMatch(/not retried automatically/);
    await bridge.stop();
  });

  it("still RETRIES a prompt that rejects before any activity (nothing ran, so a replay is safe)", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([]);
    agent.failNext("Claude Code process aborted by user");
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "hello" });
    await tick(60);

    expect(events.some((e) => e.type === "RUN_RETRYING")).toBe(true);
    expect(agent.startedCount()).toBe(2);
    expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(true);
    await bridge.stop();
  });

  it("does NOT retry a genuine model RUN_ERROR ('agent reported an error') — that's a real answer", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "error" } }]); // the model itself reported an error
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "trigger a model error" });
    await tick(40);

    expect(events.some((e) => e.type === "RUN_RETRYING")).toBe(false); // NOT retried
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(1); // ran exactly once
    await bridge.stop();
  });
});

describe("clarifyRunError (context-overflow → clear message)", () => {
  it("rewrites known context-overflow errors to a start-a-new-chat nudge", () => {
    for (const raw of [
      "API error: context_length_exceeded",
      "prompt is too long: 250000 tokens > 200000 maximum",
      "Error: the context window was exceeded",
      "too many tokens in the request",
    ]) {
      expect(clarifyRunError(raw)).toMatch(/conversation is too long|context window is full|start a new chat/i);
    }
  });

  it("passes an unrelated error through unchanged", () => {
    const raw = "connection reset by peer";
    expect(clarifyRunError(raw)).toBe(raw);
  });
});

/**
 * A wedged session must not be retried through: each dead-on-arrival attempt
 * mints a fresh session and the user's message is persisted once.
 */
describe("a wedged run recreates the agent session", () => {
  const mk = (agent: ReturnType<typeof createFakeAcpAgent>, over: Record<string, unknown> = {}) => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    let made = 0;
    const bridge = createSessionBridge({
      config: { cwd: "/w", skillsDir: "/s", agent: { command: "f", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      // A factory whose call count tells whether the pump re-initialized or reused the wedged session.
      acpClient: () => {
        made++;
        return Promise.resolve(acpClientFromTransport(agent.transport, exec));
      },
      firstActivityTimeoutMs: 25,
      deathRetryMax: 2,
      deathRetryBaseMs: 1,
      ...over,
    } as never);
    return { bridge, sessions: () => made };
  };

  it("THE FIX: a dead-on-arrival run does not retry through the SAME session", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([]); // emits nothing
    agent.gate();       // ...and hangs
    const { bridge, sessions } = mk(agent);
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "hello?" } as never);
    await new Promise((r) => setTimeout(r, 400));

    expect(sessions(), "each wedged attempt must mint a FRESH session").toBeGreaterThan(1);
  });

  it("does NOT re-persist the user's message on a retry", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([]);
    agent.gate();
    const { bridge } = mk(agent);
    // onPersist rather than onEvent, because the user's message is written to the log.
    const seen: Array<{ type: string; delta?: string }> = [];
    bridge.onPersist((e: { type: string; delta?: string }) => seen.push(e));
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "the only copy" } as never);
    await new Promise((r) => setTimeout(r, 400));

    const copies = seen.filter((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "the only copy");
    expect(copies.length, "the prompt is logged once, not once per attempt").toBe(1);
  });
});

// --- the RUN_STARTED origin stamp ----------------------------------------------------------
//
// isOwnRun compares a run's origin to the pod reading it, and these tests pin the epoch half of
// the stamp because a pod name alone cannot distinguish this process from its predecessor under
// the same StatefulSet name.

describe("RUN_STARTED origin stamp", () => {
  const mkBridge = (agent: ReturnType<typeof createFakeAcpAgent>, deps: Record<string, unknown>) => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    return createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
      ...deps,
    } as never);
  };
  // RUN_STARTED goes out on both channels, so only onEvent is subscribed to avoid counting every run twice.
  const starts = (events: AguiEvent[]) =>
    events.filter((e) => e.type === "RUN_STARTED") as Array<{ host?: string; gen?: number }>;

  it("carries the epoch, and re-reads it PER RUN", async () => {
    // The epoch is read per run, so a conversation reassigned away and back mid-session stamps the epoch each run started under.
    let generation: number | undefined = 5;
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    const bridge = mkBridge(agent, { selfPod: "agent-host-0", generation: () => generation });
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "go" } as never);

    generation = 6;
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    await bridge.prompt({ threadId: "t1", text: "again" } as never);

    expect(starts(events).map((s) => [s.host, s.gen])).toEqual([
      ["agent-host-0", 5],
      ["agent-host-0", 6],
    ]);
  });

  it("omits the epoch when none is observed — and isOwnRun then falls back to the host name", async () => {
    // During boot the pod knows its name but not its epoch, so the epoch is absent and the name alone decides.
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    const bridge = mkBridge(agent, { selfPod: "agent-host-0", generation: () => undefined });
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "go" } as never);

    const [started] = starts(events);
    expect(started.gen).toBeUndefined();
    expect(isOwnRun(started, { host: "agent-host-0", gen: 4 }), "name match still holds").toBe(true);
    expect(isOwnRun(started, { host: "agent-host-1", gen: 4 }), "another pod is still foreign").toBe(false);
  });

  it("a run stamped at an OLDER epoch is not ours, even under the same pod name", async () => {
    const agent = createFakeAcpAgent();
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    const bridge = mkBridge(agent, { selfPod: "agent-host-0", generation: () => 5 });
    const events = collect(bridge);
    await bridge.start();
    await bridge.prompt({ threadId: "t1", text: "go" } as never);

    const [started] = starts(events);
    // Same pod name both times, so only the epoch separates the two verdicts.
    expect(isOwnRun(started, { host: "agent-host-0", gen: 7 })).toBe(false);
    expect(isOwnRun(started, { host: "agent-host-0", gen: 5 })).toBe(true);
  });
});

describe("bridge auto-resume after a lost agent container", () => {
  const mkBridge = (agent: ReturnType<typeof createFakeAcpAgent>) => {
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    return createSessionBridge({
      config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
      exec,
      acpClient: acpClientFromTransport(agent.transport, exec),
      firstActivityTimeoutMs: 0,
      deathRetryMax: 2,
      deathRetryBaseMs: 5,
      deathRetryCapMs: 20,
    });
  };
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  const chunk = { emit: { sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text: "working" } } };

  /** A working turn that loses its container with `error`. */
  const cutOff = async (agent: ReturnType<typeof createFakeAcpAgent>, bridge: ReturnType<typeof createSessionBridge>, error: string) => {
    agent.setScript([chunk]);
    agent.gate();
    await bridge.start();
    void bridge.prompt({ threadId: "t1", text: "do the task" });
    await tick(10);
    agent.failNext(error);
  };

  it("sends one resume prompt after a working turn is cut off", async () => {
    const agent = createFakeAcpAgent();
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    const persisted = collectPersist(bridge);
    await cutOff(agent, bridge, "container disconnected mid-run");
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.releaseGate();
    await tick(40);

    const err = events.find((e) => e.type === "RUN_ERROR") as { message: string };
    expect(err.message).toContain("continue once it reconnects");
    const resume = persisted.find((e) => e.type === "SYSTEM_MESSAGE" && e.source === "agent-host") as { text: string } | undefined;
    expect(resume?.text).toBe(RESUME_AFTER_DISCONNECT);
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(2);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    await bridge.stop();
  });

  it("waits out a container that is still gone, via the retry backoff", async () => {
    const agent = createFakeAcpAgent();
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await cutOff(agent, bridge, "container disconnected mid-run");
    // Hold the resume so its first attempt fails before working.
    agent.setScript([]);
    agent.releaseGate();
    agent.gate();
    await tick(10);
    agent.failNext("container not connected (session s1)");
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.releaseGate();
    await tick(60);

    expect(events.some((e) => e.type === "RUN_RETRYING")).toBe(true);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    await bridge.stop();
  });

  it("resumes at most once, even when the resume is cut off too", async () => {
    const agent = createFakeAcpAgent();
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await cutOff(agent, bridge, "unknown session abc (container restarted)");
    agent.releaseGate();
    agent.gate();
    await tick(10);
    agent.failNext("container disconnected mid-run");
    agent.releaseGate();
    await tick(40);

    const errors = events.filter((e) => e.type === "RUN_ERROR") as { message: string }[];
    expect(errors.length).toBe(2);
    expect(errors[1].message).toContain("send a message to continue");
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(2);
    await bridge.stop();
  });

  it("does not resume a turn that failed for another reason", async () => {
    const agent = createFakeAcpAgent();
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    await cutOff(agent, bridge, "model overloaded");
    agent.releaseGate();
    await tick(40);

    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(1);
    expect((events.find((e) => e.type === "RUN_ERROR") as { message: string }).message).toContain("send a message to continue");
    await bridge.stop();
  });

  it("leaves the work to a message the user already queued", async () => {
    const agent = createFakeAcpAgent();
    const bridge = mkBridge(agent);
    const events = collect(bridge);
    const persisted = collectPersist(bridge);
    await cutOff(agent, bridge, "container disconnected mid-run");
    void bridge.prompt({ threadId: "t1", text: "are you there?" });
    await tick(5);
    agent.setScript([{ finish: { stopReason: "end_turn" } }]);
    agent.releaseGate();
    await tick(40);

    expect(persisted.some((e) => e.type === "SYSTEM_MESSAGE" && e.source === "agent-host")).toBe(false);
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(2);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    await bridge.stop();
  });
});
