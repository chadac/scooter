/**
 * A revive that had to build a new Sandbox tells the user and the agent that /workspace was
 * reset, before the agent sees the message that woke it.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionBridge, type AguiEvent } from "../../src/bridge.js";
import type { AcpClient, PromptParams, SessionUpdate } from "../../src/acp/client.js";
import { createSessionManager, SANDBOX_RESET_NOTE, SANDBOX_UPDATE_NOTE, type SandboxProvisioner } from "../../src/session/manager.js";
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

/** A manager over real bridges with a scripted sandbox resume. */
function harness(root: string, resume: (ref: { name: string; namespace: string }) => Promise<{ name: string; namespace: string; fresh?: boolean; updatePending?: boolean }>) {
  const agent = recordingAgent();
  const provisioner: SandboxProvisioner = {
    create: vi.fn(async (id: string) => ({ name: `conv-${id}`, namespace: "ns", fresh: true })),
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
  return { agent, provisioner, sessions, logged, store };
}

const notes = (events: AguiEvent[]) =>
  (events as Array<{ type: string; source?: string; text?: string }>).filter(
    (e) => e.type === "SYSTEM_MESSAGE" && e.source === "sandbox",
  );

describe("reviving into a recreated sandbox", () => {
  it("logs a visible note and puts it ahead of the user's message in the agent's prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "reset-note-"));
    try {
      const { agent, sessions, logged } = harness(root, async (ref) => ({ ...ref, fresh: true }));
      const conv = await sessions.start("thread-reset");
      await sessions.suspend(conv.id);

      await sessions.promptByThread("thread-reset" as never, "where were we?", undefined);

      const logged1 = notes(await logged(conv.id));
      expect(logged1).toHaveLength(1);
      expect(logged1[0].text).toBe(SANDBOX_RESET_NOTE);
      const prompt = agent.prompts.at(-1) ?? "";
      expect(prompt.indexOf("/workspace is empty")).toBeGreaterThan(-1);
      expect(prompt.indexOf("/workspace is empty")).toBeLessThan(prompt.indexOf("where were we?"));

      await sessions.promptByThread("thread-reset" as never, "again", undefined);
      expect(agent.prompts.at(-1), "the note goes out once").not.toContain("/workspace is empty");
      await logged(conv.id); // drain appends before the directory goes
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("says nothing when the sandbox simply resumed", async () => {
    const root = mkdtempSync(join(tmpdir(), "reset-none-"));
    try {
      const { agent, sessions, logged } = harness(root, async (ref) => ref);
      const conv = await sessions.start("thread-plain");
      await sessions.suspend(conv.id);
      await sessions.promptByThread("thread-plain" as never, "hello", undefined);
      expect(notes(await logged(conv.id))).toEqual([]);
      expect(agent.prompts.at(-1)).not.toContain("/workspace is empty");
      await logged(conv.id);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("reviving into a pod kept behind its template", () => {
  it("tells the agent once that an update is waiting, before the user's message", async () => {
    const root = mkdtempSync(join(tmpdir(), "update-note-"));
    try {
      const { agent, sessions, logged } = harness(root, async (ref) => ({ ...ref, updatePending: true }));
      const conv = await sessions.start("thread-update");
      await sessions.suspend(conv.id);

      await sessions.promptByThread("thread-update" as never, "keep going", undefined);

      expect(notes(await logged(conv.id)).map((n) => n.text)).toEqual([SANDBOX_UPDATE_NOTE]);
      const prompt = agent.prompts.at(-1) ?? "";
      expect(prompt.indexOf("update for this sandbox is waiting")).toBeGreaterThan(-1);
      expect(prompt.indexOf("update for this sandbox is waiting")).toBeLessThan(prompt.indexOf("keep going"));

      await sessions.promptByThread("thread-update" as never, "again", undefined);
      expect(agent.prompts.at(-1)).not.toContain("update for this sandbox is waiting");
      await logged(conv.id);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("creating a hydrated conversation's sandbox", () => {
  const seed = (sandboxRef?: string) => ({
    id: "thread-seeded" as SessionId, threadId: "thread-seeded" as never, title: "", createdAt: 1, lastActivityAt: 1,
    ...(sandboxRef ? { sandboxRef } : {}),
  });

  it("says nothing for a conversation that never had a sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "reset-first-"));
    try {
      const { agent, provisioner, sessions, logged, store } = harness(root, async (ref) => ref);
      await store.saveMeta!(seed());
      await sessions.promptByThread("thread-seeded" as never, "hello", undefined);
      expect(provisioner.create).toHaveBeenCalled();
      expect(notes(await logged("thread-seeded" as SessionId))).toEqual([]);
      expect(agent.prompts.at(-1)).not.toContain("/workspace is empty");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("notes the reset when its recorded sandbox was reaped", async () => {
    const root = mkdtempSync(join(tmpdir(), "reset-reaped-"));
    try {
      const { agent, provisioner, sessions, logged, store } = harness(root, async (ref) => ref);
      await store.saveMeta!(seed("conv-thread-seeded"));
      await sessions.promptByThread("thread-seeded" as never, "where were we?", undefined);
      expect(provisioner.create).toHaveBeenCalled();
      expect(notes(await logged("thread-seeded" as SessionId))).toHaveLength(1);
      expect(agent.prompts.at(-1)).toContain("/workspace is empty");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
