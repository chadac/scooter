/**
 * Tier 1 contract — the RECOVERED (suspended → revived) conversation seams.
 *
 * The reported user story, which nothing covered end-to-end: a conversation is
 * suspended (idle sweep / rollout drops the pod + bridge), the user opens the tab
 * and sends a message. Three things went wrong in the field:
 *
 *   1. a NEW AWS approval raised AFTER the revive never appeared in the tab,
 *   2. events.integrity "totally fails" and the UI sits with the message hidden,
 *   3. the sent message shows in the queue tab and is never flushed.
 *
 * The existing coverage all stubs the seam it should be exercising:
 *   - integrityRoute.spec.ts *says* "first-hit on a suspended conversation" but its
 *     SessionManager is a `{id}` literal with `ensureReadable: async () => true` —
 *     it never builds a suspended conversation at all.
 *   - management.spec.ts's fakeSessions() hard-codes ensureReadable to "does the map
 *     have it", so the real hydrate-as-suspended-placeholder path never runs.
 *   - session.spec.ts covers suspend/revive on the MANAGER but never against the
 *     integrity route the UI actually reads from.
 *
 * So these tests wire the REAL createSessionManager (fake provisioner + a real
 * file-backed store) to the REAL management router, and drive the actual
 * suspend → connect → send → revive sequence.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createSessionManager,
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

/** A minimal fake bridge that records prompts and can raise interrupts, so a
 *  revive produces a real (new) bridge instance we can assert on — the thing the
 *  approval-after-revive path depends on. */
function makeFakeBridge(onEmit: (e: AguiEvent) => void) {
  const listeners: Array<(e: AguiEvent) => void> = [];
  // The manager logs via onPersist (wireEventLog), NOT onEvent — subscribing to
  // both would double-log. A fake that omits it silently persists nothing, which
  // would make these tests pass for the wrong reason.
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
    server: { onPermission: () => {}, broadcast: () => {} } as never,
    answerPermission: async () => {},
  });

describe("recovered (suspended → revived) conversations", () => {
  it("events.integrity serves 200 + full history for a SUSPENDED conversation (no 404)", async () => {
    // Bug #2: "events.integrity call totally fails". The route must NOT gate on
    // liveness — a suspended conversation has no pod and no bridge, but its durable
    // log is the whole point of suspend-don't-delete. A 404 here makes the UI
    // silently backoff-poll forever (integrityAgent's "not-found" branch surfaces
    // NOTHING to the user) while the message sits hidden.
    const root = mkdtempSync(join(tmpdir(), "susp-integrity-"));
    try {
      const { store, sessions } = harness(root);
      const conv = await sessions.start("thread-susp-1");
      await sessions.prompt(conv.id, "before the nap");
      await store.flush?.(conv.id);

      // Genuinely suspend: drops the bridge, sets status "suspended".
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
    // Bug #3: the message "disappears" / sticks in the queue tab. The UI clears its
    // optimistic queued entry only once the server confirms the text (queue snapshot
    // or the message in the log — RuntimeProvider's push pump). So the send MUST
    // revive and persist, or the bubble is stuck forever.
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
    // Bug #1: "new approvals for AWS don't appear in the tab" after a revive. The
    // bridge that held the interrupt died with the pod; index.ts hangs
    // reRaisePendingAwsInterrupts off onRevived. The contract that matters is that
    // onRevived fires AFTER a LIVE bridge exists — re-raising onto a dead/absent
    // bridge is a silent no-op (reRaisePendingAwsInterrupts early-returns on
    // `if (!bridge) return`), which is exactly the invisible-approval bug.
    const root = mkdtempSync(join(tmpdir(), "susp-approval-"));
    try {
      const { sessions, bridges, revived } = harness(root);
      const conv = await sessions.start("thread-susp-3");
      await sessions.suspend(conv.id);
      expect(bridges.get(conv.id)).toBeDefined(); // the pre-suspend bridge object

      await sessions.revive(conv.id);

      expect(revived, "revive must notify so pending approvals are re-raised").toContain(conv.id);
      const bridge = bridges.get(conv.id)!;
      expect(bridge.started, "onRevived is useless without a started bridge to raise onto").toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an approval raised AFTER a revive reaches the integrity stream", async () => {
    // The full bug-#1 round trip: revive, then raise a NEW AWS approval, and assert
    // it is DURABLE — an interrupt that only ever exists in bridge memory is invisible
    // to a tab that connects (or reconnects) afterwards.
    const root = mkdtempSync(join(tmpdir(), "susp-approval-e2e-"));
    try {
      const { store, sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-susp-4");
      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);

      // The broker's aws-request path raises onto the (revived) bridge.
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
    // The e2e shows the post-revive approval panel vanishing on reload, while the
    // same reload on a LIVE conversation keeps it. A reload re-derives pendingApprovals
    // purely from the replayed log, so "panel gone after reload" == "not in the log".
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
  // The BROKER does not know the conversation UUID: its identity comes from the
  // sandbox SA name `sandbox-{shortId}` (broker/core/auth.py _SA_PATTERN), so
  // _notify_host POSTs /conversations/{SHORT_ID}/aws-request. The host must resolve
  // that short hash back to the conversation — including after a suspend, when the
  // entry may have been evicted from memory entirely.
  const shortIdOf = (threadId: string): string => {
    let h = 0;
    for (let i = 0; i < threadId.length; i++) h = (h * 31 + threadId.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  };

  it("getByShortId still resolves a SUSPENDED conversation (the broker's only handle)", async () => {
    const root = mkdtempSync(join(tmpdir(), "susp-shortid-"));
    try {
      const { sessions } = harness(root);
      const conv = await sessions.start("thread-broker-1");
      await sessions.suspend(conv.id);

      const found = await sessions.getByShortId(shortIdOf("thread-broker-1"));
      expect(
        found?.id,
        "the broker addresses the conversation ONLY by short id — a suspend must not orphan it",
      ).toBe(conv.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("getByShortId resolves after a REVIVE too (the id-space must not shift)", async () => {
    const root = mkdtempSync(join(tmpdir(), "susp-shortid-2-"));
    try {
      const { sessions } = harness(root);
      const conv = await sessions.start("thread-broker-2");
      await sessions.suspend(conv.id);
      await sessions.revive(conv.id);

      const found = await sessions.getByShortId(shortIdOf("thread-broker-2"));
      expect(found?.id).toBe(conv.id);
      expect(found?.status, "a revived conversation must present as running").toBe("running");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queued messages survive suspend → revive", () => {
  it("a message queued at suspend is PERSISTED and RE-RUN on revive (not destroyed)", async () => {
    // The reported bug: the run queue lives in the bridge closure, which suspend()
    // drops, and revive() builds a fresh empty one — so the user's already-sent
    // message silently never ran and never errored. suspend() now drains the queue
    // onto the entry (persisted), and revive() re-enqueues it.
    const root = mkdtempSync(join(tmpdir(), "susp-queue-"));
    try {
      const { sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-queue-1");
      const first = bridges.get(conv.id)!;
      // Simulate a message sitting in the bridge queue when the suspend lands.
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

      // Suspend + revive again with nothing newly queued — the old message must NOT
      // be replayed (that would re-run work the user already got).
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
    // The subtle half of the queue-preservation fix: suspend() persists pendingQueue
    // into meta.json, but hydrate rebuilds the Entry from listConversations(), which
    // reconstructs the meta FIELD BY FIELD. A field missing there is silently dropped,
    // so the queued message survives an in-process suspend→revive (that reads the
    // in-memory entry) yet is LOST across a restart / cross-replica hydrate — exactly
    // the rollout case this feature exists for.
    const root = mkdtempSync(join(tmpdir(), "susp-restart-"));
    try {
      // Process 1: queue a message, then suspend (persists pendingQueue).
      const first = harness(root);
      const conv = await first.sessions.start("thread-restart-1");
      first.bridges.get(conv.id)!.queued = [{ text: "survive the restart", priority: 0 }];
      await first.sessions.suspend(conv.id);

      // Process 2: a FRESH manager over the same state dir (an agent-host restart).
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
  // runPrompt persists the user message BEFORE calling the agent, so a message that was
  // IN FLIGHT when the suspend landed is already in the log. Replaying it blindly would
  // show it (and answer it) twice and repeat any side effects the interrupted run had
  // started. Dedupe lives in the agent-host, against the log — the authority that
  // survives restarts and is the same thing the UI renders — rather than in each caller.

  it("does NOT replay a message that is ALREADY in the log (no duplicate turn)", async () => {
    const root = mkdtempSync(join(tmpdir(), "susp-dedupe-"));
    try {
      const { store, sessions, bridges } = harness(root);
      const conv = await sessions.start("thread-dedupe-1");

      // The interrupted run had already persisted this user message before dying.
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

  it("STILL replays a message that never reached the log (the case that matters)", async () => {
    // A message that never started has no log entry, so dedupe must not swallow it —
    // that is precisely the silent-loss bug this whole feature exists to fix.
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
