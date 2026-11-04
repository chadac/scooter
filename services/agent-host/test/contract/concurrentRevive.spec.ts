/**
 * Two prompts that reach a suspended conversation at the same moment (a GitHub review and its
 * comments arrive within a millisecond) must share one revive. Building two bridges ran two
 * agent processes on one session and raced two writers on the event log.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionManager, type SandboxProvisioner } from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { AguiEvent } from "../../src/bridge.js";

function fakeBridge() {
  const persist: Array<(e: AguiEvent) => void> = [];
  return {
    started: 0,
    prompts: [] as string[],
    async start() { this.started++; },
    async stop() {},
    async prompt(input: { text: string }) {
      this.prompts.push(input.text);
      for (const l of persist) l({ type: "TEXT_MESSAGE_CONTENT", messageId: `u-${this.prompts.length}`, delta: input.text } as AguiEvent);
    },
    drainQueue: () => [],
    answerPermission: () => true,
    onEvent() {},
    onPersist(cb: (e: AguiEvent) => void) { persist.push(cb); return () => {}; },
    onTitle() {},
    queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
  };
}

describe("concurrent revive", () => {
  it("two simultaneous prompts to a suspended conversation build one bridge and both land on it", async () => {
    const root = mkdtempSync(join(tmpdir(), "conc-revive-"));
    try {
      let releaseResume!: () => void;
      const gate = new Promise<void>((r) => { releaseResume = r; });
      const provisioner: SandboxProvisioner = {
        create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" })),
        suspend: vi.fn(async () => {}),
        // Hold the resume open so the second prompt arrives mid-revive.
        resume: vi.fn(async (ref) => { await gate; return ref; }),
        destroy: vi.fn(async () => {}),
      };
      const store = createFileConversationStore(root);
      const bridges: Array<ReturnType<typeof fakeBridge>> = [];
      const sessions = createSessionManager({
        provisioner,
        store,
        bridgeFactory: () => {
          const b = fakeBridge();
          bridges.push(b);
          return b as never;
        },
      });

      const conv = await sessions.start("thread-conc");
      await sessions.suspend(conv.id);
      const before = bridges.length;

      const a = sessions.promptByThread("thread-conc" as never, "review", undefined);
      const b = sessions.promptByThread("thread-conc" as never, "review comment", undefined);
      await new Promise((r) => setTimeout(r, 10));
      releaseResume();
      await Promise.all([a, b]);

      expect(provisioner.resume, "one revive must resume the sandbox once").toHaveBeenCalledTimes(1);
      expect(bridges.length - before, "concurrent prompts must share one bridge").toBe(1);
      const live = bridges[bridges.length - 1];
      expect(live.prompts).toEqual(["review", "review comment"]);
      // The prompts return once queued; the revive's start() lands behind them.
      await vi.waitFor(() => expect(live.started).toBe(1));
      expect(sessions.get(conv.id)?.status).toBe("running");
      await new Promise((r) => setTimeout(r, 20));
      await store.flush?.(conv.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
