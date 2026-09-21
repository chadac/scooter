/**
 * Regression — end() must fence the writes that race it, or the conversation
 * comes back from the dead.
 *
 * end() is not atomic: it awaits bridge.stop(), provisioner.destroy() and
 * store.removeConversation() in sequence. A resume nudge (the dangling-run
 * reconcile fires `void prompt(..., "resume")`) that started before the DELETE
 * is still holding the Entry across that window, and revive()'s awaited
 * `saveMeta(entry)` then writes the meta row back AFTER removeConversation
 * dropped it. The conversation is now readable again — GET /conversations/:id
 * hydrates it and answers 200 forever — with a pod the DELETE was meant to
 * reclaim still running. Why: PR #549.
 *
 * Caught by the nightly flake run: sessions.spec.ts "deleting a conversation
 * removes it from the list" polled for a 404 and got 200 for the full 30s, the
 * resurrected row wearing the resume nudge as its title. The gate below makes
 * that interleaving deterministic instead of one-in-five.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionManager, type SandboxProvisioner, type SandboxRef } from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { AguiEvent } from "../../src/bridge.js";

function makeFakeBridge() {
  return {
    async start() {},
    async stop() {},
    async prompt() {},
    answerPermission: () => true,
    onEvent(_cb: (e: AguiEvent) => void) {},
    onPersist(_cb: (e: AguiEvent) => void) {
      return () => {};
    },
    onTitle() {},
    queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
  };
}

/** A provisioner whose resume() parks on a gate the test opens by hand, so
 *  revive() is guaranteed to still be mid-flight when end() runs. `live` tracks
 *  the pods it believes exist, so a test can assert the DELETE reclaimed them. */
function gatedProvisioner() {
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const live = new Set<string>();
  const provisioner: SandboxProvisioner = {
    create: vi.fn(async (id: string) => {
      const ref = { name: `conv-${id}`, namespace: "ns" };
      live.add(ref.name);
      return ref;
    }),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async (ref: SandboxRef) => {
      await gate;
      live.add(ref.name);
      return ref;
    }),
    destroy: vi.fn(async (ref: SandboxRef) => {
      live.delete(ref.name);
    }),
  };
  return { provisioner, open, live };
}

const harness = (root: string, provisioner: SandboxProvisioner) =>
  createSessionManager({
    provisioner,
    store: createFileConversationStore(root) as never,
    bridgeFactory: () => makeFakeBridge() as never,
  });

describe("end() vs a concurrent revive", () => {
  it("a revive that outlives the DELETE does not write the conversation back", async () => {
    const root = mkdtempSync(join(tmpdir(), "end-resurrect-"));
    try {
      const { provisioner, open, live } = gatedProvisioner();
      const sessions = harness(root, provisioner);
      const conv = await sessions.start("thread-end-1");
      await sessions.suspend(conv.id);

      // Park a revive inside provisioner.resume, then delete underneath it.
      const revived = sessions.revive(conv.id).then(
        () => undefined,
        () => undefined,
      );
      await sessions.end(conv.id);
      open();
      await revived;

      expect(sessions.get(conv.id), "the ended conversation must not be back in memory").toBeUndefined();
      const metas = (await createFileConversationStore(root).listConversations?.()) ?? [];
      expect(
        metas.map((m) => m.id),
        "a late saveMeta must not resurrect the row the DELETE removed",
      ).not.toContain(conv.id);
      // The point of the DELETE is reclaiming the pod; a revive that resumed one
      // after end()'s destroy must clean up after itself or it leaks silently.
      expect([...live], "the DELETE must leave no sandbox behind").toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the deleted conversation stays unreadable — GET must keep answering 404", async () => {
    const root = mkdtempSync(join(tmpdir(), "end-readable-"));
    try {
      const { provisioner, open } = gatedProvisioner();
      const sessions = harness(root, provisioner);
      const conv = await sessions.start("thread-end-2");
      await sessions.suspend(conv.id);

      const revived = sessions.revive(conv.id).then(
        () => undefined,
        () => undefined,
      );
      await sessions.end(conv.id);
      open();
      await revived;

      // This is the assertion the e2e test makes through the HTTP route: the read
      // path hydrates-if-absent, so a surviving row (or CR) reads as a live
      // conversation rather than a 404.
      expect(
        await sessions.ensureReadable(conv.id),
        "an ended conversation must not be hydratable again",
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not tear down an unrelated conversation", async () => {
    const root = mkdtempSync(join(tmpdir(), "end-neighbour-"));
    try {
      const { provisioner, open } = gatedProvisioner();
      const sessions = harness(root, provisioner);
      const doomed = await sessions.start("thread-end-3a");
      const keep = await sessions.start("thread-end-3b");
      await sessions.suspend(doomed.id);

      const revived = sessions.revive(doomed.id).then(
        () => undefined,
        () => undefined,
      );
      await sessions.end(doomed.id);
      open();
      await revived;

      // The fence is keyed per conversation; a blanket "stop persisting" would
      // pass the tests above and silently stop saving everything else.
      expect(sessions.get(keep.id), "the other conversation is untouched").toBeDefined();
      expect(await sessions.ensureReadable(keep.id)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
