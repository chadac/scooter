import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScooterBackend, type AguiEvent, type ChildSession, type ScooterApi, type SessionsApi } from "../src/scooterBackend.js";
import { ProtocolCore } from "../src/vendor/hydra-ahp/protocol/core.js";
import type { ActionRequest } from "../src/vendor/hydra-ahp/protocol/backend.js";
import { RouterRefused } from "../src/conversationView.js";

const CONV = "6c5b0a0c-887e-4328-929f-43f3e727c162";
const SESSION = `scooter:/${CONV}`;
const chatOf = (s: string) => "ahp-chat://default/" + Buffer.from(s, "utf8").toString("base64url");

/** A fake conversation: `emit` feeds the live event stream; history is whatever was emitted before start. */
function fakeConversation(history: AguiEvent[] = []) {
  const sinks = new Set<(ev: AguiEvent) => void>();
  const sent: string[] = [];
  let cancels = 0;
  const api: ScooterApi = {
    async stream(onEvent, signal) {
      for (const ev of history) onEvent(ev);
      sinks.add(onEvent);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { sinks.delete(onEvent); resolve(); }));
    },
    async sendMessage(text) { sent.push(text); },
    async cancel() { cancels++; },
  };
  return { api, sent, cancels: () => cancels, emit: (...evs: AguiEvent[]) => evs.forEach((e) => sinks.forEach((s) => s(e))) };
}

/** A fake router: the primary conversation plus the sessions created under it. */
function fakeRouter(history: AguiEvent[] = [], children: ChildSession[] = []) {
  const convs = new Map([[CONV, fakeConversation(history)]]);
  const ended: string[] = [];
  let next = 0;
  const api: SessionsApi = {
    async create(titlePrefix) {
      const child = { id: `child-${++next}`, title: `${titlePrefix}: New chat`, status: "suspended" };
      children.push(child);
      return child;
    },
    async list() { return children; },
    async end(id) { ended.push(id); },
    conversation(id) {
      if (!convs.has(id)) convs.set(id, fakeConversation());
      return convs.get(id)!.api;
    },
  };
  return { api, ended, get created() { return next; }, conv: (id = CONV) => convs.get(id)! };
}

async function setup(history: AguiEvent[] = [], opts: { children?: ChildSession[]; statePath?: string } = {}) {
  const router = fakeRouter(history, opts.children);
  const backend = new ScooterBackend({ conversationId: CONV, conversationUrl: "https://scooter.example/?thread=x", api: router.api, statePath: opts.statePath });
  const core = new ProtocolCore({ backend, detachGraceMs: 0 });
  await core.start();
  await new Promise((r) => setTimeout(r, 0)); // let the pumps replay history
  const chat = (session = SESSION) => core.store.state(chatOf(session)) as any;
  /** What the core does for a client dispatch: ask the backend, then apply the accepted action. */
  const dispatch = async (channel: string, action: Record<string, unknown>) => {
    const req = { channel, action, origin: { clientId: "vscode", clientSeq: 1 }, client: { clientId: "vscode", version: "0.9.0" } } as unknown as ActionRequest;
    const d = await backend.handleAction(req);
    if (d.accept) core.publish(channel, action as never, req.origin);
    return d;
  };
  /** Sends a prompt from a session's chat and lets its conversation start. */
  const prompt = async (session: string, text = "hi") => {
    await dispatch(chatOf(session), { type: "chat/turnStarted", turnId: `vs-${text}`, startedAt: new Date().toISOString(), message: { text, origin: { kind: "user" } } });
    await new Promise((r) => setTimeout(r, 0));
  };
  const primary = router.conv();
  return { ...primary, router, backend, core, chat, dispatch, prompt };
}

const user = (id: string, text: string): AguiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "user" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];
const say = (id: string, text: string): AguiEvent[] => [
  { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
  { type: "TEXT_MESSAGE_END", messageId: id },
];
const tool = (id: string, name: string, args: object, result: string): AguiEvent[] => [
  { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
  { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
  { type: "TOOL_CALL_END", toolCallId: id },
  { type: "TOOL_CALL_RESULT", toolCallId: id, messageId: `${id}-r`, content: result },
];
const fromVscode = (id: string, text: string): AguiEvent => ({ type: "SYSTEM_MESSAGE", messageId: id, source: "vscode", text });
const run = (runId: string, ...evs: AguiEvent[][]): AguiEvent[] => [
  { type: "RUN_STARTED", threadId: CONV, runId },
  ...evs.flat(),
  { type: "RUN_FINISHED", threadId: CONV, runId },
];

describe("ScooterBackend", () => {
  it("advertises this conversation's agent and the session agent, usable without a GitHub sign-in", async () => {
    const { core } = await setup();
    const root = core.store.state("ahp-root://") as any;
    expect(root.agents.map((a: any) => a.provider)).toEqual(["scooter", "scooter-session"]);
    for (const a of root.agents) expect(a).toMatchObject({ protectedResources: [] });
    expect(root.agents[0].models).toHaveLength(1); // VS Code requires a model for agent-host providers
  });

  it("lists this conversation when it has no sessions", async () => {
    const { backend } = await setup();
    const { items } = (await backend.listSessions()) as any;
    expect(items.map((s: any) => s.resource)).toEqual([SESSION]);
  });

  it("replays history into completed turns", async () => {
    const { chat } = await setup([
      ...user("u1", "list files"),
      ...run("r1", tool("t1", "mcp__sandbox__bash", { command: "ls" }, "a\nb\n"), say("m1", "Two files.")),
    ]);
    const c = chat();
    expect(c.activeTurn).toBeUndefined();
    expect(c.turns).toHaveLength(1);
    expect(c.turns[0].message.text).toBe("list files");
    expect(c.turns[0].state).toBe("complete");
    const kinds = c.turns[0].responseParts.map((p: any) => p.kind);
    expect(kinds).toEqual(["toolCall", "markdown"]);
    expect(c.turns[0].responseParts[0].toolCall.status).toBe("completed");
    expect(c.turns[0].responseParts[1].content).toBe("Two files.");
  });

  it("hides platform system messages and HTML comments in replies", async () => {
    const { chat } = await setup([
      ...user("u1", "deploy it"),
      ...run("r1", [{ type: "SYSTEM_MESSAGE", messageId: "s1", source: "github", text: "CI is GREEN" }],
        [{ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
          ...["Done.<", "!-- not wait", "ing --", "> Bye", " <!"].map((delta) => ({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta })),
          { type: "TEXT_MESSAGE_END", messageId: "m1" }]),
    ]);
    const c = chat();
    expect(c.turns.map((t: any) => t.message.text)).toEqual(["deploy it"]);
    expect(c.turns[0].responseParts[0].content).toBe("Done. Bye <!");
  });

  it("sends a VS Code prompt to Scooter and adopts the router's echo instead of opening a second turn", async () => {
    const { chat, dispatch, sent, emit } = await setup();
    const d = await dispatch(chatOf(SESSION), { type: "chat/turnStarted", turnId: "vs-1", startedAt: new Date().toISOString(), message: { text: "hi", origin: { kind: "user" } } });
    expect(d).toEqual({ accept: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["hi"]);
    emit(...run("r2", user("u2", "hi"), say("m2", "hello!")));
    const c = chat();
    expect(c.turns).toHaveLength(1);
    expect(c.turns[0].id).toBe("vs-1");
    expect(c.turns[0].responseParts.map((p: any) => p.content)).toEqual(["hello!"]);
  });

  it("refuses tool approvals from VS Code", async () => {
    const { dispatch } = await setup();
    const d = await dispatch(chatOf(SESSION), { type: "chat/toolCallConfirmed", turnId: "t", toolCallId: "x", approved: true });
    expect(d.accept).toBe(false);
  });

  it("shows a pending approval as a note and keeps the turn open", async () => {
    const { chat, emit } = await setup();
    emit(...user("u3", "deploy"), { type: "RUN_STARTED", threadId: CONV, runId: "r3" },
      { type: "RUN_FINISHED", threadId: CONV, runId: "r3", outcome: { type: "interrupt" } });
    const c = chat();
    expect(c.activeTurn).toBeDefined();
    expect(JSON.stringify(c.activeTurn)).toContain("Waiting for approval");
  });

  it("starts a child conversation for each session VS Code creates", async () => {
    const { backend, chat, router, emit, dispatch } = await setup([...user("u1", "earlier"), ...run("r1", say("m1", "earlier reply"))]);
    const created = "scooter-session:/new-from-vscode";
    await backend.handleCommand("createSession", { channel: created }, {} as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(chat(created).turns).toHaveLength(0); // its own, empty history
    expect(router.created).toBe(0); // no conversation until the first prompt
    expect(((await backend.listSessions()) as any).items.map((s: any) => s.resource)).toEqual([SESSION]);
    await dispatch(chatOf(created), { type: "chat/turnStarted", turnId: "vs-1", startedAt: new Date().toISOString(), message: { text: "hi", origin: { kind: "user" } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(router.conv("child-1").sent).toEqual(["hi"]);
    emit(...user("u2", "later"), ...run("r2", say("m2", "later reply")));
    expect(chat(SESSION).turns).toHaveLength(2);
    expect(chat(created).turns).toHaveLength(0); // the parent's turns stay out of the session
    expect(chat(created).activeTurn.id).toBe("vs-1");
    const { items } = (await backend.listSessions()) as any;
    expect(items.map((s: any) => s.resource)).toEqual([SESSION, created]);
    await expect(backend.handleCommand("createSession", { channel: "copilotcli:/x" }, {} as never)).rejects.toThrow();
  });

  it("lists sessions that existed before the bridge started", async () => {
    const { backend, chat } = await setup([], { children: [{ id: "old", title: "Earlier chat" }, { id: "gone", status: "ended" }] });
    const { items } = (await backend.listSessions()) as any;
    expect(items.map((s: any) => [s.resource, s.title])).toEqual([[SESSION, "Scooter conversation"], ["scooter-session:/old", "Earlier chat"]]);
    expect(chat("scooter-session:/old")).toBeDefined();
  });

  it("keeps VS Code's URI for a session across a bridge restart", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "ahp-")), "sessions.json");
    const children: ChildSession[] = [];
    const first = await setup([], { children, statePath });
    await first.backend.handleCommand("createSession", { channel: "scooter-session:/vscode-picked" }, {} as never);
    await first.prompt("scooter-session:/vscode-picked");
    first.backend.stop();
    const second = await setup([], { children, statePath });
    const { items } = (await second.backend.listSessions()) as any;
    expect(items.map((s: any) => s.resource)).toEqual([SESSION, "scooter-session:/vscode-picked"]);
  });

  it("stops following a conversation the router refuses", async () => {
    const { router } = await setup();
    let attempts = 0;
    router.conv().api.stream = async () => { attempts++; throw new RouterRefused(403, "events.integrity"); };
    const logs: string[] = [];
    const backend = new ScooterBackend({ conversationId: CONV, api: router.api, log: (m) => logs.push(m) });
    await new ProtocolCore({ backend, detachGraceMs: 0 }).start();
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts).toBe(1);
    expect(logs).toEqual([`${CONV}: stopped following: events.integrity: 403`]);
    backend.stop();
  });

  it("suspends a deleted session and keeps it hidden", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "ahp-")), "sessions.json");
    const children: ChildSession[] = [];
    const { backend, prompt, router, core } = await setup([], { children, statePath });
    await backend.handleCommand("createSession", { channel: "scooter-session:/idle" }, {} as never);
    await backend.handleCommand("disposeSession", { channel: "scooter-session:/idle" }, {} as never);
    expect(router.created).toBe(0); // never prompted: nothing started, nothing to end
    await backend.handleCommand("createSession", { channel: "scooter-session:/doomed" }, {} as never);
    await prompt("scooter-session:/doomed");
    await backend.handleCommand("disposeSession", { channel: "scooter-session:/doomed" }, {} as never);
    expect(router.ended).toEqual(["child-1"]);
    expect(core.store.has("scooter-session:/doomed")).toBe(false);
    await backend.handleCommand("disposeSession", { channel: SESSION }, {} as never); // never the primary
    expect(core.store.has(SESSION)).toBe(true);
    const restarted = await setup([], { children, statePath });
    const { items } = (await restarted.backend.listSessions()) as any;
    expect(items.map((s: any) => s.resource)).toEqual([SESSION]);
  });

  it("links a session's approval note to its own conversation", async () => {
    const { backend, prompt, chat, router } = await setup();
    await backend.handleCommand("createSession", { channel: "scooter-session:/s" }, {} as never);
    await prompt("scooter-session:/s");
    router.conv("child-1").emit(...user("u", "deploy"), { type: "RUN_STARTED", threadId: "child-1", runId: "r" },
      { type: "RUN_FINISHED", threadId: "child-1", runId: "r", outcome: { type: "interrupt" } });
    expect(JSON.stringify(chat("scooter-session:/s").activeTurn)).toContain("thread=child-1");
  });

  it("adopts a prompt's echo as a vscode system message without an extra or empty turn", async () => {
    const { chat, dispatch, emit } = await setup();
    await dispatch(chatOf(SESSION), { type: "chat/turnStarted", turnId: "vs-1", startedAt: new Date().toISOString(), message: { text: "hi", origin: { kind: "user" } } });
    emit(...run("r2", [fromVscode("s1", "hi")], say("m2", "hello!")));
    const c = chat();
    expect(c.turns.map((t: any) => t.id)).toEqual(["vs-1"]);
    expect(c.turns[0].responseParts.map((p: any) => p.content)).toEqual(["hello!"]);
  });

  it("opens a chat of the Scooter agent on this conversation, and closing it ends nothing", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "ahp-")), "sessions.json");
    const { backend, chat, dispatch, sent, emit, router } = await setup([...user("u1", "earlier"), ...run("r1", say("m1", "earlier reply"))], { statePath });
    const other = "scooter:/second-chat";
    await backend.handleCommand("createSession", { channel: other }, {} as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(chat(other).turns).toHaveLength(1); // this conversation's history
    await dispatch(chatOf(other), { type: "chat/turnStarted", turnId: "vs-2", startedAt: new Date().toISOString(), message: { text: "more", origin: { kind: "user" } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["more"]);
    emit(...run("r2", [fromVscode("s2", "more")], say("m2", "ok")));
    expect(chat(other).turns.map((t: any) => t.id)).toEqual(["scooter-u1", "vs-2"]);
    expect(chat(SESSION).turns.map((t: any) => [t.message.text, t.message.origin?.kind])).toEqual([["earlier", "user"], ["more", "user"]]);

    const restarted = await setup([], { statePath });
    expect((await restarted.backend.listSessions() as any).items.map((s: any) => s.resource)).toEqual([SESSION, other]);
    await backend.handleCommand("disposeSession", { channel: other }, {} as never);
    expect(router.ended).toEqual([]);
  });

  it("names a session with the vscode prefix and picks up the agent's title", async () => {
    const children: ChildSession[] = [];
    const { backend, prompt } = await setup([], { children });
    await backend.handleCommand("createSession", { channel: "scooter-session:/t" }, {} as never);
    await prompt("scooter-session:/t");
    children[0].title = "vscode: Fix the login redirect";
    const { items } = (await backend.listSessions()) as any;
    expect(items.map((s: any) => s.title)).toEqual(["Scooter conversation", "vscode: Fix the login redirect"]);
  });

  it("answers resolveSessionConfig with an empty config", async () => {
    const { backend } = await setup();
    expect(await backend.handleCommand("resolveSessionConfig", { provider: "scooter" }, {} as never)).toEqual({ schema: { type: "object", properties: {} }, values: {} });
  });

  it("forwards Stop to the router and ends the turn on CANCEL_REQUESTED", async () => {
    const { chat, emit, dispatch, cancels } = await setup();
    emit(...user("u4", "long task"), { type: "RUN_STARTED", threadId: CONV, runId: "r4" });
    const turnId = chat().activeTurn.id;
    await dispatch(chatOf(SESSION), { type: "chat/turnCancelled", turnId, duration: 1 });
    expect(cancels()).toBe(1);
    emit({ type: "CANCEL_REQUESTED", threadId: CONV, runId: "r4" }); // must not double-cancel
    expect(chat().activeTurn).toBeUndefined();
    expect(chat().turns.at(-1).state).toBe("cancelled");
  });
});
