/**
 * Contract tests for recovered (suspended, then revived) conversations: a new
 * approval raised after the revive must reach the tab, events.integrity must keep
 * serving the durable log, and a message sent while suspended must revive the
 * conversation and run. The real createSessionManager (fake provisioner, real
 * file-backed store) is wired to the real management router.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createSessionManager,
  shortId,
  type SandboxProvisioner,
  type SessionManager,
} from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import { createManagementApi } from "../../src/api/management.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SessionId } from "../../src/types.js";

const fakeProvisioner = (): SandboxProvisioner => ({
  create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" })),
  suspend: vi.fn(async () => {}),
  resume: vi.fn(async (ref) => ref),
  destroy: vi.fn(async () => {}),
});

/** A minimal fake bridge that records prompts and can raise interrupts, so a revive produces a new instance to assert on. */
function makeFakeBridge(onEmit: (e: AguiEvent) => void) {
  const listeners: Array<(e: AguiEvent) => void> = [];
  // The manager logs via onPersist, not onEvent; a fake without it persists nothing.
  const persistListeners: Array<(e: AguiEvent) => void> = [];
  const emit = (e: AguiEvent) => {
    onEmit(e);
    for (const l of listeners) l(e);
    for (const l of persistListeners) l(e);
  };
  return {
    started: false,
    prompts: [] as string[],
    interrupts: [] as string[],
    async start() {
      this.started = true;
    },
    async stop() {
      this.started = false;
    },
    async prompt(input: { text: string }) {
      this.prompts.push(input.text);
      emit({ type: "TEXT_MESSAGE_CONTENT", messageId: `u-${this.prompts.length}`, delta: input.text } as AguiEvent);
    },
    /** Mirrors the real bridge's external-interrupt shape (the AWS approval). */
    raiseInterrupt(id: string, message: string) {
      this.interrupts.push(id);
      emit({ type: "RUN_STARTED", threadId: "t", runId: `ext-${id}` } as AguiEvent);
      emit({
        type: "RUN_FINISHED",
        threadId: "t",
        runId: `ext-${id}`,
        outcome: { type: "interrupt", interrupts: [{ id, message, options: [{ id: "approve", label: "Approve" }] }] },
      } as unknown as AguiEvent);
    },
    /** Test-settable stand-in for the real bridge's in-memory run queue. */
    queued: [] as Array<{ text: string; priority: number }>,
    drainQueue() {
      const out = this.queued;
      this.queued = [];
      return out;
    },
    answerPermission: () => true,
    onEvent(cb: (e: AguiEvent) => void) {
      listeners.push(cb);
    },
    onPersist(cb: (e: AguiEvent) => void) {
      persistListeners.push(cb);
      return () => {};
    },
    onTitle() {},
    queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
  };
}

/** Build the real manager + a real file store, wired to fake bridges. */
function harness(root: string) {
  const store = createFileConversationStore(root);
  const bridges = new Map<string, ReturnType<typeof makeFakeBridge>>();
  const revived: string[] = [];
  const sessions = createSessionManager({
    provisioner: fakeProvisioner(),
    store,
    bridgeFactory: ({ conversationId }) => {
      const b = makeFakeBridge(() => {});
      bridges.set(conversationId, b);
      return b as never;
    },
    onRevived: (id) => revived.push(id),
  });
  return { store, sessions, bridges, revived };
}

/** Open the integrity SSE stream and collect frames until closed. */
function openIntegrity(api: ReturnType<typeof createManagementApi>, id: string) {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as { method?: string }).method = "GET";
  (req as { url?: string }).url = `/conversations/${id}/events.integrity`;
  (req as { headers?: Record<string, string> }).headers = {};
  let body = "";
  let status = 0;
  const res = {
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    write: (c: string) => {
      body += c;
      return true;
    },
    end: (c?: string) => {
      if (c) body += c;
    },
    on: () => res,
    req,
  } as unknown as ServerResponse;
  const matched = api.handle(req, res);
  return {
    done: matched.then(() => body),
    body: () => body,
    status: () => status,
    close: () => (req as PassThrough).emit("close"),
  };
}

const apiFor = (sessions: SessionManager, store: ReturnType<typeof createFileConversationStore>) =>
  createManagementApi({
    sessions,
    store,
    server: { broadcast: () => {} } as never,
    answerInterrupt: async () => ({ ok: true }),
  });

describe("recovered (suspended → revived) conversations", () => {
  it("events.integrity serves 200 + full history for a SUSPENDED conversation (no 404)", async () => {
    // The route must not gate on liveness: a 404 makes the UI backoff-poll forever with the message hidden.
    const root = mkdtempSync(join(tmpdir(), "susp-integrity-"));
    try {
      const { store, sessions } = harness(root);
      const conv = await sessions.start("thread-susp-1");
      await sessions.prompt(conv.id, "before the nap");
      await store.flush?.(conv.id);

      await sessions.suspend(conv.id);
      expect(sessions.get(conv.id)?.status).toBe("suspended");

      const api = apiFor(sessions, store);
      const stream = openIntegrity(api, conv.id);
      await new Promise((r) => setTimeout(r, 50));
      stream.close();
      const body = await stream.done;

      expect(stream.status(), "a suspended conversation must still be readable").toBe(200);
      expect(body).toContain('"kind":"synced"');
      expect(body, "history must replay off the durable log with no live pod").toContain("before the nap");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a message sent to a SUSPENDED conversation revives it and lands in the log", async () => {
    // The UI clears its optimistic queued entry only once the server confirms the text, so the send must revive and persist.
    const root = mkdtempSync(join(tmpdir(), "susp-send-"));
    try {
      const { store, sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-susp-2");
      await sessions.suspend(conv.id);

      // The send path the /agui POST takes.
      await sessions.promptByThread("thread-susp-2" as never, "please wake up", undefined);

      expect(sessions.get(conv.id)?.status, "the send must revive the conversation").toBe("running");
      const bridge = bridges.get(conv.id)!;
      expect(bridge.started, "revive must start a live bridge").toBe(true);
      expect(bridge.prompts, "the message must reach the revived bridge").toContain("please wake up");

      await store.flush?.(conv.id);
      const seen: AguiEvent[] = [];
      for await (const e of store.readEvents(conv.id as SessionId)) seen.push(e);
      const text = JSON.stringify(seen);
      expect(text, "the sent message must be durably logged (else the queue bubble never clears)").toContain(
        "please wake up",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("revive fires onRevived so a NEW approval can be re-raised on the rebuilt bridge", async () => {
    // index.ts re-raises pending AWS interrupts from onRevived, which is a silent no-op unless a live bridge exists by then.
    const root = mkdtempSync(join(tmpdir(), "susp-approval-"));
    try {
      const { sessions, bridges, revived } = harness(root);
      const conv = await sessions.start("thread-susp-3");
      await sessions.suspend(conv.id);
      expect(bridges.get(conv.id)).toBeDefined();

      await sessions.revive(conv.id);

      expect(revived, "revive must notify so pending approvals are re-raised").toContain(conv.id);
      const bridge = bridges.get(conv.id)!;
      expect(bridge.started, "onRevived is useless without a started bridge to raise onto").toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an approval raised AFTER a revive reaches the integrity stream", async () => {
    // An interrupt that only exists in bridge memory is invisible to a tab that connects afterwards.
    const root = mkdtempSync(join(tmpdir(), "susp-approval-e2e-"));
    try {
      const { store, sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-susp-4");
      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);

      bridges.get(conv.id)!.raiseInterrupt("awsreq-after-revive", "approve s3:GetObject");
      await store.flush?.(conv.id);

      const api = apiFor(sessions, store);
      const stream = openIntegrity(api, conv.id);
      await new Promise((r) => setTimeout(r, 50));
      stream.close();
      const body = await stream.done;

      expect(stream.status()).toBe(200);
      expect(body, "the post-revive approval must be replayable to a connecting tab").toContain(
        "awsreq-after-revive",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("post-revive interrupt durability (reload survival)", () => {
  it("an interrupt raised after a revive is in the DURABLE log exactly once", async () => {
    // A reload re-derives pendingApprovals purely from the replayed log.
    const root = mkdtempSync(join(tmpdir(), "susp-durable-"));
    try {
      const { store, sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-durable-1");
      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);

      bridges.get(conv.id)!.raiseInterrupt("awsreq-durable", "approve me");
      await store.flush?.(conv.id);

      const seen: AguiEvent[] = [];
      for await (const e of store.readEvents(conv.id as SessionId)) seen.push(e);
      const raised = seen.filter(
        (e) => JSON.stringify(e).includes("awsreq-durable") && e.type === "RUN_FINISHED",
      );
      expect(raised.length, "the post-revive interrupt must be persisted exactly once").toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("broker-shaped AWS request against a recovered conversation", () => {
  // The broker addresses a conversation only by the key in its sandbox SA name, so the host must resolve it even after a suspend.
  // An older conversation, recorded with the short-hash Sandbox it was created in.
  const legacyMeta = (id: string) => ({
    id: id as SessionId, threadId: id as never, title: "t", createdAt: 1, lastActivityAt: 1,
    sandboxRef: `conv-${shortId(id)}`,
  });

  it("getBySandboxKey still resolves a SUSPENDED conversation (the broker's only handle)", async () => {
    const root = mkdtempSync(join(tmpdir(), "susp-key-"));
    try {
      const { sessions } = harness(root);
      const conv = await sessions.start("thread-broker-1");
      await sessions.suspend(conv.id);

      const found = await sessions.getBySandboxKey("thread-broker-1");
      expect(
        found?.id,
        "the broker addresses the conversation ONLY by its sandbox key — a suspend must not orphan it",
      ).toBe(conv.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("getBySandboxKey resolves after a REVIVE too (the id-space must not shift)", async () => {
    const root = mkdtempSync(join(tmpdir(), "susp-key-2-"));
    try {
      const { sessions } = harness(root);
      const conv = await sessions.start("thread-broker-2");
      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);

      const found = await sessions.getBySandboxKey("thread-broker-2");
      expect(found?.id).toBe(conv.id);
      expect(found?.status, "a revived conversation must present as running").toBe("running");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an older conversation still resolves by its legacy short hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "susp-key-legacy-"));
    try {
      const { store, sessions } = harness(root);
      await store.saveMeta!(legacyMeta("legacy-1"));

      const found = await sessions.getBySandboxKey(shortId("legacy-1"));
      expect(found?.id).toBe("legacy-1");
      expect(found?.sandbox.name).toBe(`conv-${shortId("legacy-1")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a legacy short hash two conversations share @proves", async () => {
    const root = mkdtempSync(join(tmpdir(), "susp-key-collide-"));
    try {
      const { store, sessions } = harness(root);
      // "Aa" and "BB" hash alike, so these two share a short id.
      expect(shortId("legacy-Aa")).toBe(shortId("legacy-BB"));
      await store.saveMeta!(legacyMeta("legacy-Aa"));
      await store.saveMeta!(legacyMeta("legacy-BB"));

      expect(await sessions.getBySandboxKey(shortId("legacy-Aa"))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to start a conversation whose id cannot name a sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "susp-key-bad-"));
    try {
      const { sessions } = harness(root);
      await expect(sessions.start("Not_A_Name")).rejects.toThrow(/cannot name a sandbox/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queued messages survive suspend → revive", () => {
  it("a message queued at suspend is PERSISTED and RE-RUN on revive (not destroyed)", async () => {
    // suspend() drains the bridge queue onto the persisted entry and revive() re-enqueues it.
    const root = mkdtempSync(join(tmpdir(), "susp-queue-"));
    try {
      const { sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-queue-1");
      const first = bridges.get(conv.id)!;
      first.queued = [{ text: "queued before the suspend", priority: 0 }];

      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);

      const revivedBridge = bridges.get(conv.id)!;
      expect(
        revivedBridge.prompts,
        "the message queued at suspend must RUN on the revived bridge",
      ).toContain("queued before the suspend");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-enqueued messages are cleared, so a second revive does not replay them", async () => {
    const root = mkdtempSync(join(tmpdir(), "susp-queue-2-"));
    try {
      const { sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-queue-2");
      bridges.get(conv.id)!.queued = [{ text: "run me once", priority: 0 }];

      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);
      expect(bridges.get(conv.id)!.prompts).toContain("run me once");

      // A second suspend/revive with nothing newly queued must not replay the old message.
      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);
      const secondRevive = bridges.get(conv.id)!;
      expect(
        secondRevive.prompts.filter((p) => p === "run me once"),
        "a re-enqueued message must not replay on every later revive",
      ).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pendingQueue survives a RESTART (not just an in-process revive)", () => {
  it("listConversations carries pendingQueue through, so hydrate can replay it", async () => {
    // hydrate rebuilds the entry from listConversations(), which reconstructs the meta field by field.
    const root = mkdtempSync(join(tmpdir(), "susp-restart-"));
    try {
      // Process 1: queue a message, then suspend.
      const first = harness(root);
      const conv = await first.sessions.start("thread-restart-1");
      first.bridges.get(conv.id)!.queued = [{ text: "survive the restart", priority: 0 }];
      await first.sessions.suspend(conv.id);

      // Process 2: a fresh manager over the same state dir.
      const second = harness(root);
      const metas = (await second.store.listConversations?.()) ?? [];
      const meta = metas.find((m) => m.threadId === "thread-restart-1");
      expect(meta, "the conversation must be listed after a restart").toBeDefined();
      expect(
        meta?.pendingQueue?.map((q) => q.text),
        "pendingQueue must survive the meta round-trip, or the queued message is lost on restart",
      ).toContain("survive the restart");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("in-flight replay is DEDUPED against the durable log", () => {
  // runPrompt persists the user message before calling the agent, so an in-flight message is already in the log and must not be replayed.

  it("does NOT replay a message that is ALREADY in the log (no duplicate turn)", async () => {
    const root = mkdtempSync(join(tmpdir(), "susp-dedupe-"));
    try {
      const { store, sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-dedupe-1");

      // The role rides the TEXT_MESSAGE_START, which is what the dedupe keys on.
      await store.appendEvent(conv.id as SessionId, {
        type: "TEXT_MESSAGE_START",
        messageId: "u-inflight",
        role: "user",
      } as unknown as AguiEvent);
      await store.appendEvent(conv.id as SessionId, {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "u-inflight",
        delta: "cut off mid-run",
      } as AguiEvent);
      await store.flush?.(conv.id);

      bridges.get(conv.id)!.queued = [{ text: "cut off mid-run", priority: 0 }];
      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);

      expect(
        bridges.get(conv.id)!.prompts.filter((p) => p === "cut off mid-run"),
        "an already-logged message must NOT be re-run (it would duplicate the turn)",
      ).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an ASSISTANT message quoting the text does NOT suppress the replay", async () => {
    // TEXT_MESSAGE_CONTENT carries no role, so matching deltas blindly would let an assistant echo swallow a message that never ran.
    const root = mkdtempSync(join(tmpdir(), "susp-dedupe-3-"));
    try {
      const { store, sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-dedupe-3");

      // An assistant turn containing the same text.
      await store.appendEvent(conv.id as SessionId, {
        type: "TEXT_MESSAGE_START",
        messageId: "a-1",
        role: "assistant",
      } as unknown as AguiEvent);
      await store.appendEvent(conv.id as SessionId, {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "a-1",
        delta: "deploy the thing",
      } as AguiEvent);
      await store.flush?.(conv.id);

      bridges.get(conv.id)!.queued = [{ text: "deploy the thing", priority: 0 }];
      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);

      expect(
        bridges.get(conv.id)!.prompts.filter((p) => p === "deploy the thing"),
        "only USER turns may dedupe a replay — an assistant echo must not swallow it",
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("STILL replays a message that never reached the log (the case that matters)", async () => {
    // A message that never started has no log entry, so dedupe must not swallow it.
    const root = mkdtempSync(join(tmpdir(), "susp-dedupe-2-"));
    try {
      const { sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-dedupe-2");
      bridges.get(conv.id)!.queued = [{ text: "never started", priority: 0 }];

      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);

      expect(
        bridges.get(conv.id)!.prompts.filter((p) => p === "never started"),
        "a message that never ran MUST still be replayed",
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
