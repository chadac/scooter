/**
 * Derived runs (resume, background-job and subagent wakeups, subagents themselves) inherit
 * the human-or-not trigger of the run that caused them, so a BYOC conversation keeps its
 * remote agent mid-task while an autonomous one still cannot reach it.
 */

import { describe, it, expect, vi } from "vitest";

import { createRemotePersonalizedProvider, humanTriggerFromLog } from "../../src/acp/remoteAgentRegistry.js";
import { isPostableSource, SANDBOX_SOURCE } from "../../src/api/management.js";
import { createSessionManager, type ConversationStore, type SandboxProvisioner } from "../../src/session/manager.js";
import type { AguiEvent, PromptInput, SessionBridge } from "../../src/bridge.js";
import type { ExecBackend, SessionId } from "../../src/types.js";

const user = (id: string): AguiEvent => ({ type: "TEXT_MESSAGE_START", messageId: id, role: "user" });
const sys = (source: string): AguiEvent => ({ type: "SYSTEM_MESSAGE", messageId: `sys-${source}`, source, text: "x" });

describe("humanTriggerFromLog", () => {
  it("a UI prompt followed only by derived wakeups is human", () => {
    expect(humanTriggerFromLog([user("u1"), sys("resume"), sys("background job"), sys("subagent"), sys("hook")])).toBe(true);
  });
  it("a human source tagged as a system message is human", () => {
    expect(humanTriggerFromLog([sys("slack"), sys("resume")])).toBe(true);
  });
  it("the LATEST direct trigger wins: a scheduler prompt after a UI one is not human", () => {
    expect(humanTriggerFromLog([user("u1"), sys("scheduler"), sys("background job")])).toBe(false);
  });
  it("a sandbox's own message after a UI prompt is not human", () => {
    expect(humanTriggerFromLog([user("u1"), sys(SANDBOX_SOURCE), sys("resume")])).toBe(false);
  });
  it("a log with no direct trigger fails closed", () => {
    expect(humanTriggerFromLog([])).toBe(false);
    expect(humanTriggerFromLog([sys("resume")])).toBe(false);
  });
});

describe("remote-personalized honours an inherited trigger", () => {
  const exec = {} as ExecBackend;
  const connected = (async () =>
    new Response(JSON.stringify({ sessionId: "s1", status: "connected" }), { status: 200 })) as unknown as typeof fetch;
  const p = createRemotePersonalizedProvider({ exec, controllerUrl: "http://c:8080", fetchImpl: connected });
  const ctx = (source: string | undefined, humanInitiated?: boolean) =>
    ({ conversationId: "c1", owner: "alice", source, humanInitiated }) as never;

  it("a derived source inheriting a human trigger is eligible", async () => {
    await expect(p.eligible(ctx("resume", true))).resolves.toBe(true);
    await expect(p.eligible(ctx("background job", true))).resolves.toBe(true);
  });
  it("a derived source without an inherited trigger is not", async () => {
    await expect(p.eligible(ctx("resume"))).resolves.toBe(false);
  });
  it("an inherited non-human trigger wins over an undefined (interactive-looking) source", async () => {
    await expect(p.eligible(ctx(undefined, false))).resolves.toBe(false);
  });
});

describe("POST /messages cannot borrow a derived source", () => {
  it("rejects every derived source", () => {
    for (const s of ["resume", "subagent", "parent-clarification", "background job"]) expect(isPostableSource(s)).toBe(false);
    expect(isPostableSource("ci-bot")).toBe(true);
  });
});

describe("SessionManager passes the inherited trigger to the bridge", () => {
  const provisioner = (): SandboxProvisioner => ({
    create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" })),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async (ref) => ref),
    destroy: vi.fn(async () => {}),
  });

  function harness() {
    const logs = new Map<SessionId, AguiEvent[]>();
    const store: ConversationStore = {
      appendEvent: async (id, e) => {
        (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
      },
      async *readEvents(id) {
        yield* logs.get(id) ?? [];
      },
      gooseStatePath: (id) => `/state/${id}/goose`,
    };
    const prompts = new Map<string, PromptInput[]>();
    let toDrain: ReturnType<SessionBridge["drainQueue"]> = [];
    const bridgeFactory = ({ conversationId }: { conversationId: string }) =>
      ({
        onEvent: () => () => {},
        onPersist: () => () => {},
        prompt: async (input: PromptInput) => {
          (prompts.get(conversationId) ?? prompts.set(conversationId, []).get(conversationId)!).push(input);
        },
        cancel: () => {},
        stop: async () => {},
        start: async () => {},
        queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
        answerPermission: () => {},
        drainQueue: () => toDrain.splice(0),
      }) as unknown as SessionBridge;
    const sessions = createSessionManager({ provisioner: provisioner(), store, bridgeFactory });
    const seed = (id: string, ...events: AguiEvent[]) => Promise.all(events.map((e) => store.appendEvent(id as SessionId, e)));
    const last = (id: string) => prompts.get(id)?.at(-1);
    const queueForSuspend = (q: typeof toDrain) => (toDrain = q);
    return { sessions, seed, last, queueForSuspend };
  }

  it("a resume of a UI-started conversation inherits human; a direct prompt passes nothing", async () => {
    const h = harness();
    const c = await h.sessions.start("conv-1", undefined, "alice");
    await h.seed(c.id, user("u1"));
    await h.sessions.prompt(c.id, "nudge", undefined, undefined, undefined, undefined, undefined, "resume");
    expect(h.last(c.id)?.humanInitiated).toBe(true);
    await h.sessions.prompt(c.id, "hi", undefined, undefined, undefined, undefined, undefined, "scheduler");
    expect(h.last(c.id)?.humanInitiated).toBeUndefined();
  });

  it("a background-job wakeup in a scheduled conversation inherits non-human", async () => {
    const h = harness();
    const c = await h.sessions.start("conv-2", undefined, "alice");
    await h.seed(c.id, sys("scheduler"));
    await h.sessions.prompt(c.id, "job done", undefined, undefined, undefined, undefined, undefined, "background job");
    expect(h.last(c.id)?.humanInitiated).toBe(false);
  });

  it("a subagent and its own derived runs inherit the ROOT's trigger, not the child's log", async () => {
    const h = harness();
    const ui = await h.sessions.start("conv-ui", undefined, "alice");
    await h.seed(ui.id, user("u1"));
    const child = await h.sessions.spawnChild(ui.id, "child-ui", { prompt: "research" });
    await vi.waitFor(() => expect(h.last(child.id)?.humanInitiated).toBe(true));

    const sched = await h.sessions.start("conv-sched", undefined, "alice");
    await h.seed(sched.id, sys("scheduler"));
    const schedChild = await h.sessions.spawnChild(sched.id, "child-sched", { prompt: "research" });
    await vi.waitFor(() => expect(h.last(schedChild.id)?.humanInitiated).toBe(false));
    // The child's own log opens with a user turn; it must not count as human.
    await h.seed(schedChild.id, user("framed"));
    await h.sessions.prompt(schedChild.id, "job done", undefined, undefined, undefined, undefined, undefined, "background job");
    expect(h.last(schedChild.id)?.humanInitiated).toBe(false);
  });

  it("a message queued across a suspend keeps its source and inherited trigger", async () => {
    const h = harness();
    const c = await h.sessions.start("conv-q", undefined, "alice");
    await h.seed(c.id, sys("scheduler"));
    h.queueForSuspend([{ text: "tick", priority: 0, source: "scheduler" }, { text: "job done", priority: 0, source: "background job", humanInitiated: false }]);
    await h.sessions.suspend(c.id);
    await h.sessions.revive(c.id);
    await vi.waitFor(() => expect(h.last(c.id)?.text).toBe("job done"));
    expect(h.last(c.id)).toMatchObject({ source: "background job", humanInitiated: false });
  });
});
