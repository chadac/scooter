import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";

import type { AguiEvent } from "../../src/bridge.js";
import {
  CommentStripper,
  ConversationAgent,
  promptText,
  replayStart,
  toolKind,
  type ConversationPort,
} from "../../src/acp/conversationAgent.js";
import { acpConversationOf, feedFor, sameOrigin } from "../../src/acp/conversationSocket.js";
import type { ChecksummedEvent } from "../../src/session/manager.js";

const ID = "conv-1";
const tick = () => new Promise((r) => setImmediate(r));

const userMsg = (id: string, text: string): AguiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "user" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];
const reply = (id: string, text: string): AguiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];
const run = (runId: string, body: AguiEvent[]): AguiEvent[] => [
  { type: "RUN_STARTED", threadId: ID as never, runId: runId as never },
  ...body,
  { type: "RUN_FINISHED", threadId: ID as never, runId: runId as never },
];

/** A conversation in memory plus an ACP client on the other end of the agent. */
function harness(history: AguiEvent[] = [], opts: { answerOk?: boolean } = {}) {
  let live: ((ev: AguiEvent) => void) | undefined;
  const sent: string[] = [];
  const answers: Array<{ interruptId: string; optionId: string; result?: Record<string, unknown> }> = [];
  let cancels = 0;
  const port: ConversationPort = {
    conversationId: ID,
    conversationUrl: "https://scooter.test/chat/conv-1",
    feed: {
      async open(onLive) {
        live = onLive;
        return { history: [...history], close: () => (live = undefined) };
      },
    },
    async send(text) {
      sent.push(text);
    },
    async cancel() {
      cancels++;
    },
    async answer(interruptId, optionId, result) {
      answers.push({ interruptId, optionId, ...(result ? { result } : {}) });
      return opts.answerOk ?? true;
    },
  };
  const out: any[] = [];
  /** How the client answers session/request_permission, by call order. */
  const permissionReplies: Array<(params: any) => unknown> = [];
  const permissionRequests: any[] = [];
  let agent!: ConversationAgent;
  agent = new ConversationAgent(port, (msg) => {
    out.push(msg);
    if (msg.method === "session/request_permission") {
      permissionRequests.push(msg.params);
      const answer = permissionReplies.shift()?.(msg.params) ?? { outcome: { outcome: "cancelled" } };
      setImmediate(() => agent.peer.receive(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: answer })));
    }
  });
  let nextId = 100;
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const check = setInterval(() => {
        const res = out.find((m) => m.id === id && !m.method);
        if (!res) return;
        clearInterval(check);
        if (res.error) reject(Object.assign(new Error(res.error.message), { code: res.error.code }));
        else resolve(res.result);
      }, 1);
      agent.peer.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const updates = () => out.filter((m) => m.method === "session/update").map((m) => m.params.update);
  const emit = (...evs: AguiEvent[]) => evs.forEach((e) => live?.(e));
  return { agent, call, updates, emit, sent, answers, permissionReplies, permissionRequests, cancels: () => cancels, out };
}

describe("ConversationAgent (ACP agent over a conversation)", () => {
  it("initialize advertises loadSession and embedded context", async () => {
    const h = harness();
    const res = await h.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(res.protocolVersion).toBe(1);
    expect(res.agentCapabilities.loadSession).toBe(true);
    expect(res.agentCapabilities.promptCapabilities.embeddedContext).toBe(true);
  });

  it("session/new answers with the conversation id, then replays its turns", async () => {
    const h = harness([
      ...userMsg("u1", "plot it"),
      ...run("r1", [
        ...reply("a1", "Sure <!-- hidden marker -->done"),
        { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "mcp__sandbox__bash" },
        { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"command":"ls"}' },
        { type: "TOOL_CALL_END", toolCallId: "t1" },
        { type: "TOOL_CALL_RESULT", toolCallId: "t1", messageId: "m", content: "a.py" },
      ]),
    ]);
    const res = await h.call("session/new", { cwd: "/workspace", mcpServers: [] });
    expect(res.sessionId).toBe(ID);
    // The replay follows the response.
    expect(h.out.findIndex((m) => m.method === "session/update")).toBeGreaterThan(h.out.findIndex((m) => m.result?.sessionId));
    await tick();
    const u = h.updates();
    expect(u[0]).toEqual({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "plot it" } });
    const text = u.filter((x) => x.sessionUpdate === "agent_message_chunk").map((x) => x.content.text).join("");
    expect(text).toBe("Sure done");
    expect(u).toContainEqual({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute", status: "in_progress" });
    expect(u).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "t1", title: "bash: ls", rawInput: { command: "ls" } }));
    expect(u).toContainEqual(expect.objectContaining({ toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "a.py" } }] }));
  });

  it("replays only the latest turn, after a link to the full chat", async () => {
    const h = harness([...userMsg("u1", "old"), ...reply("a1", "old reply"), ...userMsg("u2", "new")]);
    await h.call("session/new", { cwd: "/workspace", mcpServers: [] });
    await tick();
    const u = h.updates();
    expect(u[0]).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Earlier messages are in [the Scooter chat](https://scooter.test/chat/conv-1).\n" } });
    expect(u.slice(1)).toEqual([{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "new" } }]);
  });

  it("session/load replays before answering and refuses another session id", async () => {
    const h = harness([...userMsg("u1", "hi"), ...run("r1", reply("a1", "hello"))]);
    await expect(h.call("session/load", { sessionId: "other", cwd: "/", mcpServers: [] })).rejects.toThrow(/unknown session/);
    await h.call("session/load", { sessionId: ID, cwd: "/", mcpServers: [] });
    const updates = h.out.filter((m) => m.method === "session/update");
    const answered = h.out.findIndex((m) => m.id !== undefined && !m.method && !m.error);
    expect(updates.length).toBeGreaterThan(0);
    expect(h.out.indexOf(updates[updates.length - 1])).toBeLessThan(answered);
  });

  it("a prompt becomes the user's message and ends with its own run, not one already going", async () => {
    const h = harness();
    await h.call("session/load", { sessionId: ID, cwd: "/", mcpServers: [] });
    let done: any;
    const p = h.call("session/prompt", { sessionId: ID, prompt: [{ type: "text", text: "make a chart" }] }).then((r) => (done = r));
    await tick();
    expect(h.sent).toEqual(["make a chart"]);
    // Another run finishing first doesn't end this prompt.
    h.emit({ type: "RUN_FINISHED", threadId: ID as never, runId: "r0" as never });
    await tick();
    expect(done).toBeUndefined();
    h.emit(...userMsg("u2", "make a chart"), ...run("r2", reply("a2", "Here it is")));
    expect(await p).toEqual({ stopReason: "end_turn" });
    // The panel shows its own prompt, so it isn't echoed back.
    expect(h.updates().some((u) => u.sessionUpdate === "user_message_chunk")).toBe(false);
  });

  it("session/cancel stops the run and the prompt ends cancelled", async () => {
    const h = harness();
    await h.call("session/load", { sessionId: ID, cwd: "/", mcpServers: [] });
    const p = h.call("session/prompt", { sessionId: ID, prompt: [{ type: "text", text: "go" }] });
    await tick();
    h.emit(...userMsg("u", "go"), { type: "RUN_STARTED", threadId: ID as never, runId: "r" as never });
    h.agent.peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: ID } }));
    await tick();
    expect(h.cancels()).toBe(1);
    h.emit({ type: "RUN_FINISHED", threadId: ID as never, runId: "r" as never, cancelled: true });
    expect(await p).toEqual({ stopReason: "cancelled" });
  });

  it("a live permission request goes to the client and its pick answers the interrupt", async () => {
    const h = harness();
    await h.call("session/load", { sessionId: ID, cwd: "/", mcpServers: [] });
    h.permissionReplies.push(() => ({ outcome: { outcome: "selected", optionId: "allow" } }));
    h.emit({
      type: "RUN_FINISHED", threadId: ID as never, runId: "r" as never,
      outcome: { type: "interrupt", interrupts: [{ id: "tc1", reason: "confirmation", message: "Run rm?", toolCallId: "tc1",
        metadata: { options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } }] },
    });
    for (let i = 0; i < 5; i++) await tick();
    expect(h.permissionRequests[0]).toMatchObject({ sessionId: ID, toolCall: { toolCallId: "tc1", title: "Run rm?", content: [{ type: "content", content: { type: "text", text: "Run rm?" } }] } });
    expect(h.permissionRequests[0].options.map((o: any) => o.optionId)).toEqual(["allow", "deny"]);
    expect(h.answers).toEqual([{ interruptId: "tc1", optionId: "allow" }]);
  });

  it("an interrupt still open in history is asked once the session opens; a resolved one isn't", async () => {
    const pending = (id: string): AguiEvent => ({
      type: "RUN_FINISHED", threadId: ID as never, runId: "r" as never,
      outcome: { type: "interrupt", interrupts: [{ id, reason: "confirmation", toolCallId: id, metadata: { options: [{ optionId: "ok", name: "OK", kind: "allow_once" }] } }] },
    });
    const h = harness([pending("old"), { type: "PERMISSION_RESOLVED", toolCallId: "old", optionId: "ok" }, pending("open")]);
    h.permissionReplies.push(() => ({ outcome: { outcome: "selected", optionId: "ok" } }));
    await h.call("session/load", { sessionId: ID, cwd: "/", mcpServers: [] });
    for (let i = 0; i < 5; i++) await tick();
    expect(h.permissionRequests.map((p) => p.toolCall.toolCallId)).toEqual(["open"]);
    expect(h.answers).toEqual([{ interruptId: "open", optionId: "ok" }]);
  });

  it("AskUserQuestion asks each question in turn and answers with the labels", async () => {
    const h = harness();
    await h.call("session/load", { sessionId: ID, cwd: "/", mcpServers: [] });
    h.permissionReplies.push(() => ({ outcome: { outcome: "selected", optionId: "1" } }));
    h.permissionReplies.push(() => ({ outcome: { outcome: "selected", optionId: "0" } }));
    h.emit({
      type: "RUN_FINISHED", threadId: ID as never, runId: "r" as never,
      outcome: { type: "interrupt", interrupts: [{ id: "q", reason: "confirmation", message: "Questions", toolCallId: "q", metadata: {
        options: [{ optionId: "answer", name: "Answer", kind: "allow_once" }],
        kind: "ask-user.questions",
        data: { questions: [
          { question: "Which DB?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }] },
          { question: "Which chart?", options: [{ label: "Bar" }, { label: "Line" }] },
        ] },
      } }] },
    });
    for (let i = 0; i < 10; i++) await tick();
    expect(h.permissionRequests.map((p) => p.toolCall.title)).toEqual(["DB: Which DB?", "Which chart?"]);
    expect(h.permissionRequests[0].options.map((o: any) => o.name)).toEqual(["Postgres", "SQLite"]);
    expect(h.answers).toEqual([{ interruptId: "q", optionId: "answer", result: { answers: { "Which DB?": "SQLite", "Which chart?": "Bar" } } }]);
  });

  it("a request the panel can't draw is a note linking the full chat", async () => {
    const h = harness();
    await h.call("session/load", { sessionId: ID, cwd: "/", mcpServers: [] });
    h.emit({
      type: "RUN_FINISHED", threadId: ID as never, runId: "r" as never,
      outcome: { type: "interrupt", interrupts: [{ id: "q", reason: "confirmation", message: "Pick several", metadata: {
        options: [{ optionId: "answer", name: "Answer", kind: "allow_once" }],
        kind: "ask-user.questions",
        data: { questions: [{ question: "Which?", multiSelect: true, options: [{ label: "A" }] }] },
      } }] },
    });
    for (let i = 0; i < 5; i++) await tick();
    expect(h.permissionRequests).toEqual([]);
    const text = h.updates().map((u) => u.content?.text ?? "").join("");
    expect(text).toContain("Pick several");
    expect(text).toContain("https://scooter.test/chat/conv-1");
  });
});

describe("promptText", () => {
  it("keeps the text, then notes links and embedded context", () => {
    const text = promptText([
      { type: "text", text: "fix the plot" },
      { type: "resource_link", uri: "/workspace/nb.py", mimeType: "text/x-python", name: "nb.py" },
      { type: "resource", resource: { uri: "cell://abc", text: "df.plot()" } },
    ]);
    expect(text.startsWith("fix the plot\n\n(Sent from an agent panel.")).toBe(true);
    expect(text).toContain("Attached: /workspace/nb.py");
    expect(text).toContain("df.plot()");
  });

  it("is just the text when nothing is attached", () => {
    expect(promptText([{ type: "text", text: "hi" }])).toBe("hi");
  });
});

describe("helpers", () => {
  it("replayStart keeps the last N user turns", () => {
    const h = [...userMsg("1", "a"), ...reply("x", "b"), ...userMsg("2", "c"), ...userMsg("3", "d")];
    expect(replayStart(h, 2)).toBe(6);
    expect(replayStart(h, 5)).toBe(0);
  });

  it("CommentStripper hides comments split across chunks", () => {
    const s = new CommentStripper();
    expect(s.push("a <!") + s.push("-- x --") + s.push("> b") + s.end()).toBe("a  b");
  });

  it("toolKind guesses ACP kinds from tool names", () => {
    expect(toolKind("mcp__sandbox__bash")).toBe("execute");
    expect(toolKind("mcp__sandbox__read")).toBe("read");
    expect(toolKind("mcp__sandbox__grep")).toBe("search");
    expect(toolKind("mcp__scooter-broker__kanban_set_status")).toBe("other");
  });

  it("acpConversationOf matches only the ACP socket path", () => {
    expect(acpConversationOf("/c/abc/_scooter/acp")).toBe("abc");
    expect(acpConversationOf("/c/abc/_scooter/acp/")).toBe("abc");
    expect(acpConversationOf("/c/abc/marimo/acp")).toBeUndefined();
    expect(acpConversationOf("/c/abc/_scooter/other")).toBeUndefined();
  });

  it("sameOrigin refuses another site's page", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
    expect(sameOrigin(req({ host: "abc.sbx.test" }))).toBe(true);
    expect(sameOrigin(req({ host: "abc.sbx.test", origin: "https://abc.sbx.test" }))).toBe(true);
    expect(sameOrigin(req({ host: "abc.sbx.test", origin: "https://evil.test" }))).toBe(false);
    expect(sameOrigin(req({ host: "internal:8080", "x-forwarded-host": "abc.sbx.test", origin: "https://abc.sbx.test" }))).toBe(true);
  });
});

describe("feedFor", () => {
  it("replays the log, folds appends that raced the read in once, then goes live", async () => {
    const ev = (n: number): ChecksummedEvent => ({ event: { type: "CANCEL_REQUESTED", threadId: ID as never, runId: `r${n}` as never }, prevChecksum: `c${n - 1}`, checksum: `c${n}` });
    let listener: ((id: any, c: ChecksummedEvent) => void) | undefined;
    const feed = feedFor({
      onAppend: (cb) => ((listener = cb), () => (listener = undefined)),
      async *readEventsWithChecksum() {
        yield ev(1);
        listener?.(ID, ev(2)); // lands mid-read, and is also in the log
        listener?.(ID, ev(3)); // lands mid-read, not yet in what was read
        yield ev(2);
      },
    }, ID as never);
    const live: AguiEvent[] = [];
    const { history, close } = await feed.open((e) => live.push(e));
    expect(history.map((e: any) => e.runId)).toEqual(["r1", "r2", "r3"]);
    listener?.(ID, ev(3));
    listener?.(ID, ev(4));
    listener?.("other", ev(5));
    expect(live.map((e: any) => e.runId)).toEqual(["r4"]);
    close();
    expect(listener).toBeUndefined();
  });
});
