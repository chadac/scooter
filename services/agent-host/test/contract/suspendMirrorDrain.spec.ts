/**
 * Tier 1 contract — SUSPEND must flush the conversation's coalesced mirror tail.
 *
 * The production symptom (conversations a609cd05… / 8a90fdad…): a Conversation CR alive and
 * repeatedly reassigned, but its history COMPLETELY EMPTY after a pod move. The e2e control
 * `suspend-survival.spec.ts › the TRANSCRIPT survives the emptyDir wipe` reproduces it: suspend →
 * wipe local → move pod → hydrateFromMirror serves an empty transcript.
 *
 * Mechanism (scenario (a): the mirror never had the events):
 *   - event appends are COALESCED (mirroredStore batches them as one NFS write per window),
 *   - so the most recent turns sit buffered in THIS pod's memory,
 *   - suspend() dropped the bridge + suspended the sandbox but NEVER drained that buffer —
 *     only the SIGTERM shutdown path (index.ts) drained the mirror,
 *   - so a conversation suspended by the idle sweep (no process exit) and then moved by a
 *     rollout hydrates on the new pod from a mirror MISSING those buffered turns.
 *
 * Contrast with META: title/star mirror PER-CALL (mirrorWrite, no coalescing), which is exactly
 * why the e2e's TITLE/STAR control passed under the same wipe while the TRANSCRIPT control failed.
 *
 * The fix: suspend() awaits deps.drainMirror(id) after stopping the bridge, so the mirror holds
 * the full log before this pod can be replaced. These tests wire the REAL createSessionManager to
 * a REAL mirroredConversationStore (two file stores) and drive the actual suspend, asserting the
 * buffered tail reaches the mirror — and that a fresh pod can then hydrate the full transcript.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSessionManager,
  type SandboxProvisioner,
} from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import { mirroredConversationStore } from "../../src/session/mirroredStore.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SessionId } from "../../src/types.js";

const fakeProvisioner = (): SandboxProvisioner => ({
  create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" })),
  suspend: vi.fn(async () => {}),
  resume: vi.fn(async (ref) => ref),
  destroy: vi.fn(async () => {}),
});

/** Minimal fake bridge: prompt() persists a user turn through onPersist (the manager's event log
 *  wiring), so a prompt produces a real durable event that flows into the mirrored store. */
function makeFakeBridge() {
  const persistListeners: Array<(e: AguiEvent) => void> = [];
  return {
    started: false,
    prompts: [] as string[],
    async start() { this.started = true; },
    async stop() { this.started = false; },
    async prompt(input: { text: string }) {
      this.prompts.push(input.text);
      for (const l of persistListeners)
        l({ type: "TEXT_MESSAGE_CONTENT", messageId: `u-${this.prompts.length}`, delta: input.text } as AguiEvent);
    },
    drainQueue() { return []; },
    answerPermission: () => true,
    onEvent() {},
    onPersist(cb: (e: AguiEvent) => void) { persistListeners.push(cb); return () => {}; },
    onTitle() {},
    queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
  };
}

/** Read a store's whole event log for one id, as the deltas, in order. */
async function deltas(
  store: { readEvents: (id: SessionId) => AsyncIterable<AguiEvent> },
  id: string,
): Promise<string[]> {
  const out: string[] = [];
  for await (const e of store.readEvents(id as SessionId)) {
    const d = (e as { delta?: string }).delta;
    if (typeof d === "string") out.push(d);
  }
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Real manager over a real mirrored store (two file stores). withDrain=false omits the
 *  drainMirror dep, reproducing the pre-fix behaviour for the regression contrast. The mirror
 *  options make the coalescer HOLD everything (huge batch, long window) so nothing auto-flushes —
 *  the events are provably buffered until something drains them, which is the field condition. */
function harness(localRoot: string, mirrorRoot: string, withDrain: boolean) {
  const local = createFileConversationStore(localRoot);
  const mirrorBackend = createFileConversationStore(mirrorRoot);
  const store = mirroredConversationStore(local, mirrorBackend, { maxBatch: 10_000, maxWaitMs: 3_600_000 });
  const bridges = new Map<string, ReturnType<typeof makeFakeBridge>>();
  const sessions = createSessionManager({
    provisioner: fakeProvisioner(),
    store,
    hydrateFromMirror: (id) => store.hydrateFromMirror(id),
    ...(withDrain ? { drainMirror: (id: SessionId) => store.drainMirror(id) } : {}),
    bridgeFactory: ({ conversationId }) => {
      const b = makeFakeBridge();
      bridges.set(conversationId, b);
      return b as never;
    },
  });
  return { local, mirrorBackend, store, sessions, bridges };
}

describe("suspend flushes the coalesced mirror tail (the empty-history-after-move fix)", () => {
  it("a suspended conversation's buffered turns REACH the mirror (were lost before the drain)", async () => {
    const localRoot = mkdtempSync(join(tmpdir(), "drain-local-"));
    const mirrorRoot = mkdtempSync(join(tmpdir(), "drain-mirror-"));
    try {
      const { store, mirrorBackend, sessions } = harness(localRoot, mirrorRoot, true);
      const conv = await sessions.start("thread-drain-1");
      await sessions.prompt(conv.id, "wiped turn one");
      await sessions.prompt(conv.id, "wiped turn two");
      await store.flush?.(conv.id);

      // PRECONDITION — the whole point. With a huge batch + long window the coalescer has NOT
      // flushed, so the durable mirror is still empty while local holds the turns. This is the
      // exact state a pod move would freeze: local wiped, mirror missing the tail.
      expect(await deltas(store, conv.id), "local (the authority) has the turns").toEqual([
        "wiped turn one",
        "wiped turn two",
      ]);
      expect(await deltas(mirrorBackend, conv.id), "mirror is still empty — turns are buffered").toEqual([]);

      // The fix: suspend drains the mirror.
      await sessions.suspend(conv.id);

      expect(
        await deltas(mirrorBackend, conv.id),
        "suspend must flush the buffered tail to the durable mirror, in order",
      ).toEqual(["wiped turn one", "wiped turn two"]);
    } finally {
      rmSync(localRoot, { recursive: true, force: true });
      rmSync(mirrorRoot, { recursive: true, force: true });
    }
  });

  it("after suspend, a FRESH pod hydrates the FULL transcript from the mirror (the e2e control, in miniature)", async () => {
    const localRoot = mkdtempSync(join(tmpdir(), "drain-local2-"));
    const mirrorRoot = mkdtempSync(join(tmpdir(), "drain-mirror2-"));
    const freshRoot = mkdtempSync(join(tmpdir(), "drain-fresh-"));
    try {
      const { store, sessions } = harness(localRoot, mirrorRoot, true);
      const conv = await sessions.start("thread-drain-2");
      await sessions.prompt(conv.id, "wiped turn one");
      await sessions.prompt(conv.id, "wiped turn two");
      await store.flush?.(conv.id);
      await sessions.suspend(conv.id);
      await tick(); // let the per-call meta mirror microtask settle so hydrate can find the conversation

      // A DIFFERENT pod (empty emptyDir) mirrored to the SAME durable backend — the rollout target.
      const freshLocal = createFileConversationStore(freshRoot);
      const freshMirrorBackend = createFileConversationStore(mirrorRoot);
      const freshStore = mirroredConversationStore(freshLocal, freshMirrorBackend);

      const pulled = await freshStore.hydrateFromMirror(conv.id as SessionId);
      expect(pulled, "the mirror must have this conversation for the new pod to adopt it").toBe(true);
      expect(
        await deltas(freshLocal, conv.id),
        "the reassigned pod must recover the WHOLE transcript — not an empty history",
      ).toEqual(["wiped turn one", "wiped turn two"]);
    } finally {
      rmSync(localRoot, { recursive: true, force: true });
      rmSync(mirrorRoot, { recursive: true, force: true });
      rmSync(freshRoot, { recursive: true, force: true });
    }
  });

  it("REGRESSION: without the drain, the mirror is left empty at suspend (proves the drain is the fix)", async () => {
    // The pre-fix manager (no drainMirror dep). Same suspend, but the buffered tail is abandoned —
    // exactly the data loss. This pins the mechanism to the drain, not to some incidental flush.
    const localRoot = mkdtempSync(join(tmpdir(), "nodrain-local-"));
    const mirrorRoot = mkdtempSync(join(tmpdir(), "nodrain-mirror-"));
    try {
      const { store, mirrorBackend, sessions } = harness(localRoot, mirrorRoot, false);
      const conv = await sessions.start("thread-nodrain-1");
      await sessions.prompt(conv.id, "lost turn one");
      await sessions.prompt(conv.id, "lost turn two");
      await store.flush?.(conv.id);

      await sessions.suspend(conv.id);

      expect(
        await deltas(mirrorBackend, conv.id),
        "without a drain the buffered turns never reach the mirror — the empty-history bug",
      ).toEqual([]);
    } finally {
      rmSync(localRoot, { recursive: true, force: true });
      rmSync(mirrorRoot, { recursive: true, force: true });
    }
  });
});
