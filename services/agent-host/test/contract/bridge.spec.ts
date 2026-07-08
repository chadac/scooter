/**
 * Tier 1 contract test — ACP -> AG-UI mapping (docs/DESIGN.md §4c).
 *
 * RED against the Design interfaces. Drives a fake ACP agent emitting scripted
 * session/update notifications; asserts the exact AG-UI event sequence.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge, type AguiEvent } from "../../src/bridge.js";
import type { AcpClient } from "../../src/acp/client.js";
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
  it("mints UNIQUE run/message ids across separate bridge instances (a restart must not reuse run-1/msg-1)", async () => {
    // The bug: module-global counters (run-1, msg-1, …) reset to 0 on every
    // agent-host restart, so a revived conversation re-minted ids that COLLIDED
    // with ones already in its log — the UI folds by messageId + keys runs by
    // runId, so unrelated turns merged (doubled args, scrambled runs, history that
    // won't render while a live run is going). IDs must be unique across instances.
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
    // ZERO overlap — no id from the first bridge is reused by the second.
    const overlap = [...second].filter((id) => first.has(id));
    expect(overlap, `ids reused across restart: ${overlap.join(", ")}`).toEqual([]);
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
    // PERMISSION_RESOLVED is persist-only (not a standard AG-UI event) -> separate
    // persist collector.
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

    // The run PAUSED with an interrupt, then RESUMED (a second RUN_STARTED) and
    // FINISHED for real.
    const interrupt = events.find(
      (e) => e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt",
    );
    expect(interrupt).toBeTruthy();
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(2); // paused + resumed
    // PERMISSION_RESOLVED must NOT hit the @ag-ui-validated broadcast stream
    // (it's not a standard event type — the client would reject it).
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
    // No goose run involved — raise an out-of-band interrupt (e.g. a broker AWS
    // request) and answer it via answerPermission.
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
    // Both the extra metadata AND the options survive the merge.
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

  it("emits TOOL_CALL_ARGS from the tool_call_update when the initial tool_call had no rawInput", async () => {
    // The real-world goose shape: the tool_call arrives with NO rawInput (empty
    // card), and the actual args (the shell command / the slack text) come on a
    // later tool_call_update. We must still surface them ONCE — this is the "empty
    // tool card" bug.
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
    // Exactly ONE args event (not zero, not one-per-update), carrying the command.
    expect(args).toHaveLength(1);
    expect(args[0].toolCallId).toBe("tc9");
    expect(args[0].delta).toContain("echo hi");

    // And EXACTLY ONE result — from the `completed` update, NOT the args-only
    // `in_progress` one. A premature (empty) result on the in_progress update
    // stamps the folded UI part with a result, so a still-running tool renders as
    // already complete (no spinner while e.g. `sleep 20` runs). The result must be
    // the real content, and it must arrive after the args.
    const results = events.filter((e) => e.type === "TOOL_CALL_RESULT") as Array<{ toolCallId: string; content: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("tc9");
    expect(results[0].content).toContain("hi");
  });

  it("a TERMINAL HANDOFF update does NOT complete the tool call — only the later finish does", async () => {
    // THE real-goose shell shape (captured live): the shell tool hands off a live
    // terminal, marking the update status="completed" the instant the terminal is
    // created — but the COMMAND runs async in it and only finishes on a LATER
    // update. Sequence: tool_call(Shell) -> update{completed, no content} ->
    // update{completed, content:[{terminalId,type:"terminal"}]}  (command STARTED,
    // not done) -> ... -> update{completed, no content}  (the REAL finish).
    // A premature TOOL_CALL_RESULT on the terminal-handoff folds a result onto the
    // part, so a long command (sleep 30) renders as already complete — no spinner.
    // We must emit EXACTLY ONE result, at the final update.
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

    // EXACTLY ONE result — the terminal handoff must not count as the finish.
    const results = events.filter((e) => e.type === "TOOL_CALL_RESULT");
    expect(results).toHaveLength(1);
    // And it must come AFTER the START (the tool ran, then finished).
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
    // The webhook bug: a second prompt arriving while a run is in flight clobbered
    // the single RunState, so the first run's open text message never got its END
    // and RUN_FINISHED fired with it open (the @ag-ui client rejects that). Two
    // overlapping prompts must produce TWO well-formed runs, one after the other.
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

    // Fire two prompts WITHOUT awaiting the first — they overlap.
    const p1 = bridge.prompt({ threadId: "t1", text: "first" });
    const p2 = bridge.prompt({ threadId: "t1", text: "second" });
    await Promise.all([p1, p2]);

    // Invariant: every RUN_FINISHED is emitted with NO text message open.
    const open = new Set<string>();
    for (const e of events) {
      if (e.type === "TEXT_MESSAGE_START") open.add(e.messageId);
      else if (e.type === "TEXT_MESSAGE_END") open.delete(e.messageId);
      else if (e.type === "RUN_FINISHED") {
        expect(open.size, `RUN_FINISHED while text open: ${[...open]}`).toBe(0);
      }
    }
    // And both runs actually ran (two RUN_STARTED / two RUN_FINISHED).
    expect(events.filter((e) => e.type === "RUN_STARTED")).toHaveLength(2);
    expect(events.filter((e) => e.type === "RUN_FINISHED")).toHaveLength(2);
  });
});

describe("revive history reinjection", () => {
  // An ACP client that records the prompt ContentBlock[] of every prompt() call,
  // so we can assert what goose actually received. Emits nothing + ends the turn.
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
      onPermissionRequest() {},
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
    void bridge.prompt({ threadId: "t1", text: "priority" }, { priority: 10 });
    await tick();
    expect(bridge.queueState().queued).toBe(2);
    expect(bridge.queueState().maxQueuedPriority).toBe(10);

    agent.releaseGate(); // let the queue drain
    await tick();
    await tick();
    await tick();
    // The priority prompt ran BEFORE the normal one (which was queued earlier).
    expect(order[0]).toBe("first (running)");
    expect(order.indexOf("priority")).toBeLessThan(order.indexOf("normal"));
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(3);
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
    // Three messages fired while the first run is in flight — they all queue at the
    // normal tier and must coalesce into a SINGLE follow-up run.
    void bridge.prompt({ threadId: "t1", text: "msg A" });
    void bridge.prompt({ threadId: "t1", text: "msg B" });
    void bridge.prompt({ threadId: "t1", text: "msg C" });
    await tick();
    expect(bridge.queueState().queued).toBe(3);

    agent.releaseGate();
    await tick();
    await tick();
    await tick();

    // TWO runs total: the gated first one, then ONE batched run for A+B+C (not
    // three separate runs — that's the "answer msg 1, get confused by stale msg 2"
    // problem this fixes).
    expect(events.filter((e) => e.type === "RUN_STARTED").length).toBe(2);
    // History stays faithful: each original message is persisted as its own user
    // message (goose received them combined, but the transcript shows all three).
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

    // Three runs: gated first, the priority one (its own tier), and the two normals
    // batched into one. Priority never merges with normal messages.
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
    // The run ended as a CLEAN cancelled RUN_FINISHED, not a RUN_ERROR.
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
    void bridge.prompt({ threadId: "t1", text: "@scooter urgent" }, { priority: 10 });
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

  // --- graduated interrupt LEVELS (tool-call / thinking / timeout) -------------

  it('interrupt "tool-call" cancels IMMEDIATELY (kills the running tool call)', async () => {
    const agent = createFakeAcpAgent();
    // Emit a tool_call (a tool is now in flight), then gate — the run hangs mid-tool.
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

    // A tool-call-level priority prompt preempts NOW, even though a tool is running.
    void bridge.prompt({ threadId: "t1", text: "stop now" }, { priority: 10, interrupt: "tool-call" });
    await tick();
    await tick();

    expect(agent.killCount()).toBeGreaterThanOrEqual(1); // the running tool was killed
    const fin = events.find((e) => e.type === "RUN_FINISHED") as { cancelled?: boolean } | undefined;
    expect(fin?.cancelled).toBe(true);
  });

  it('interrupt "thinking" DEFERS while a tool call is in flight, then fires at the tool boundary', async () => {
    const agent = createFakeAcpAgent();
    // A tool call starts (in flight); the run gates BEFORE the tool's result.
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

    // A thinking-level priority prompt arrives while the tool is in flight — it must
    // NOT cancel yet (don't kill the build to preempt idle thinking).
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
    // A "thinking" interrupt defers while a tool is in flight — but a tool that NEVER
    // finishes (a real `sleep 3600`, not a short poll) would defer forever. With a
    // priorityInterruptMs set, the fallback timer hard-cancels after the timeout so
    // the user's interrupting message can't be stuck behind a non-yielding tool.
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
    // The tool NEVER emits a result — so the boundary cancel can't fire. Wait past
    // the fallback timeout: the hard cancel must fire anyway.
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
    // No tool call — the run is just "thinking" (gated with nothing in flight).
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
});
