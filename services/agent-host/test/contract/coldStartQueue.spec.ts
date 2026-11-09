/**
 * A message sent to a conversation with no live bridge must be logged and queued at once,
 * not held in the request until the sandbox is ready. Held, it was invisible for the whole
 * cold start, lost if the host exited, and overtaken by a retry sent meanwhile.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionBridge, type AguiEvent } from "../../src/bridge.js";
import type { AcpClient, PromptParams, SessionUpdate } from "../../src/acp/client.js";
import { createSessionManager, type SandboxProvisioner } from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import type { SessionId } from "../../src/types.js";

/** An agent that answers every prompt "ok" and records what it was sent. */
function recordingAgent() {
  const prompts: string[] = [];
  let sessions = 0;
  let cb: ((sid: string, u: SessionUpdate) => void) | undefined;
  const client: AcpClient = {
    initialize: async () => ({ protocolVersion: 1 }),
    newSession: async () => ({ sessionId: `acp-${++sessions}` }),
    prompt: async (p: PromptParams) => {
      prompts.push(p.prompt.map((b) => (b.type === "text" ? b.text : "")).join("\n"));
      cb?.(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
      return { stopReason: "end_turn" };
    },
    cancel: async () => {},
    killActiveTerminals: async () => {},
    isAlive: () => true,
    onSessionUpdate: (f) => {
      cb = f;
      return () => {};
    },
    onTerminalCreated: () => () => {},
    onPermissionRequest: () => {},
    close: async () => {},
  };
  return { client, prompts, sessions: () => sessions };
}

/** A manager over real bridges whose sandbox resume waits for `release()`. */
function harness(root: string, resume: (ref: { name: string; namespace: string }) => Promise<{ name: string; namespace: string }>) {
  const agent = recordingAgent();
  const provisioner: SandboxProvisioner = {
    create: vi.fn(async (id: string) => ({ name: `conv-${id}`, namespace: "ns" })),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(resume),
    destroy: vi.fn(async () => {}),
  };
  const store = createFileConversationStore(root);
  const sessions = createSessionManager({
    provisioner,
    store,
    bridgeFactory: ({ conversationId, sandbox, sandboxReady }) =>
      createSessionBridge({
        conversationId,
        sandboxReady,
        config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox },
        exec: createSandboxExecBackend(createFakeSandboxApi()),
        acpClient: agent.client,
        firstActivityTimeoutMs: 0,
        livenessProbeMs: 0,
      }),
  });
  const logged = async (id: SessionId): Promise<AguiEvent[]> => {
    await store.flush?.(id);
    const out: AguiEvent[] = [];
    for await (const e of store.readEvents(id)) out.push(e);
    return out;
  };
  return { agent, provisioner, sessions, logged };
}

/** The user messages in the log, in log order. */
const userTexts = (events: AguiEvent[]): string[] => {
  const users = new Set<string>();
  const out: string[] = [];
  for (const e of events as Array<{ type: string; role?: string; messageId?: string; delta?: string }>) {
    if (e.type === "TEXT_MESSAGE_START" && e.role === "user" && e.messageId) users.add(e.messageId);
    if (e.type === "TEXT_MESSAGE_CONTENT" && e.messageId && users.has(e.messageId) && e.delta) out.push(e.delta);
  }
  return out;
};

describe("a prompt to a conversation that is still waking up", () => {
  it("is logged and queued before the sandbox is ready, and runs in the order sent", async () => {
    const root = mkdtempSync(join(tmpdir(), "cold-queue-"));
    try {
      let release!: () => void;
      const ready = new Promise<void>((r) => (release = r));
      const { agent, sessions, logged } = harness(root, async (ref) => {
        await ready;
        return ref;
      });
      const conv = await sessions.start("thread-cold");
      await sessions.suspend(conv.id);

      const a = sessions.promptByThread("thread-cold" as never, "message A", undefined);
      const b = sessions.promptByThread("thread-cold" as never, "message B", undefined);

      await vi.waitFor(async () => {
        const events = await logged(conv.id);
        expect(userTexts(events), "A's run starts and logs it before the pod is ready").toEqual(["message A"]);
        const queued = events.filter((e) => e.type === "QUEUE_UPDATED").at(-1) as { items?: Array<{ text: string }> } | undefined;
        expect(queued?.items?.map((i) => i.text), "B is durably queued behind A").toEqual(["message B"]);
      });
      expect(agent.sessions(), "nothing touches the agent before the sandbox is ready").toBe(0);

      release();
      await Promise.all([a, b]);
      expect(agent.prompts.map((p) => p.match(/message [AB]/)?.[0])).toEqual(["message A", "message B"]);
      expect(userTexts(await logged(conv.id))).toEqual(["message A", "message B"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a Stop while the sandbox is still coming up ends the run, and the agent never sees it", async () => {
    const root = mkdtempSync(join(tmpdir(), "cold-stop-"));
    try {
      let release!: () => void;
      const ready = new Promise<void>((r) => (release = r));
      const { agent, sessions, logged } = harness(root, async (ref) => {
        await ready;
        return ref;
      });
      const conv = await sessions.start("thread-stop");
      await sessions.suspend(conv.id);

      const sent = sessions.promptByThread("thread-stop" as never, "never mind", undefined);
      await vi.waitFor(async () => expect(userTexts(await logged(conv.id))).toEqual(["never mind"]));
      await sessions.get(conv.id)?.bridge?.cancel(undefined, true);
      await sent;

      const events = await logged(conv.id);
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", cancelled: true });
      release();
      await vi.waitFor(() => expect(sessions.get(conv.id)?.status).toBe("running"));
      expect(agent.prompts, "a stopped message is never sent").toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the queued run visibly when the sandbox cannot be resumed, and the next send revives afresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "cold-fail-"));
    try {
      let attempts = 0;
      const { sessions, logged } = harness(root, async (ref) => {
        if (++attempts === 1) throw new Error("no node has room");
        return ref;
      });
      const conv = await sessions.start("thread-fail");
      await sessions.suspend(conv.id);

      await sessions.promptByThread("thread-fail" as never, "first try", undefined).catch(() => {});
      await vi.waitFor(async () => {
        const events = await logged(conv.id);
        expect(userTexts(events)).toEqual(["first try"]);
        const errors = events.filter((e) => e.type === "RUN_ERROR") as Array<{ message: string; code?: string }>;
        expect(errors, "one error, not a retry storm against a dead gate").toHaveLength(1);
        expect(errors[0]).toMatchObject({ code: "sandbox_unavailable" });
        expect(errors[0].message).toContain("no node has room");
      });

      await sessions.promptByThread("thread-fail" as never, "second try", undefined);
      expect(attempts, "the second send revives again").toBe(2);
      expect(userTexts(await logged(conv.id))).toEqual(["first try", "second try"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("start() with a provisioner that knows the ref up front", () => {
  /** A harness whose create() waits for `create`'s promise. */
  function predicting(root: string, create: (id: string) => Promise<{ name: string; namespace: string }>) {
    const h = harness(root, async (ref) => ref);
    h.provisioner.create = vi.fn(create);
    h.provisioner.refFor = (id: string) => ({ name: `conv-${id}`, namespace: "ns" });
    return h;
  }

  it("returns before create() lands, and the first prompt runs once it does", async () => {
    const root = mkdtempSync(join(tmpdir(), "cold-start-"));
    try {
      let land!: () => void;
      const landed = new Promise<void>((r) => (land = r));
      const { agent, sessions } = predicting(root, async (id) => {
        await landed;
        return { name: `conv-${id}`, namespace: "ns" };
      });
      const conv = await sessions.start("thread-early");
      expect(conv.sandbox).toEqual({ name: "conv-thread-early", namespace: "ns" });

      const run = sessions.promptByThread("thread-early" as never, "hello", undefined);
      await new Promise((r) => setTimeout(r, 20));
      expect(agent.sessions(), "nothing touches the agent before create() lands").toBe(0);

      land();
      await run;
      expect(agent.prompts.some((p) => p.includes("hello"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a failed create fails the queued run, and the next prompt recreates the sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "cold-start-fail-"));
    try {
      let calls = 0;
      const { agent, provisioner, sessions } = predicting(root, async (id) => {
        if (++calls === 1) throw new Error("quota exceeded");
        return { name: `conv-${id}`, namespace: "ns" };
      });
      // The k8s provisioner's resume recreates a Sandbox that is gone.
      provisioner.resume = vi.fn(async (ref) => provisioner.create(ref.name.replace(/^conv-/, "")));
      await sessions.start("thread-fail");
      await sessions.promptByThread("thread-fail" as never, "first", undefined).catch(() => {});
      await sessions.promptByThread("thread-fail" as never, "second", undefined);
      expect(calls).toBe(2);
      expect(agent.prompts.some((p) => p.includes("second"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
