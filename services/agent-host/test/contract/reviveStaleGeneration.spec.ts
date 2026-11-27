/**
 * Suspend keeps host_pod, so the next request makes the router re-claim the row on the same pod
 * at a higher generation and forward at once. The row feed can report that bump after the
 * revive's first append, which then presents the old generation, is fenced, and stops the run.
 */

import { describe, it, expect, vi } from "vitest";

import { createSessionManager } from "../../src/session/manager.js";
import type { ConversationStore, SessionId } from "../../src/session/manager.js";
import { OwnershipTracker, type Assignment } from "../../src/session/ownershipGuard.js";

/** A tracker whose feed lags: only confirmOwns reads the row. */
class LaggingFeedTracker extends OwnershipTracker {
  constructor(self: string, private readonly row: () => Assignment) {
    super(self);
  }
  async confirmOwns(id: SessionId): Promise<boolean> {
    this.observe(id as string, this.row());
    return this.owns(id);
  }
}

const store = {
  appendEvent: async () => {},
  async *readEvents() {},
  gooseStatePath: (cid: string) => `/state/${cid}/goose`,
} as never as ConversationStore;

describe("a revive after the router re-claims a suspended conversation", () => {
  it("builds its bridge at the row's new generation, not the feed's stale one @proves", async () => {
    let row: Assignment = { hostPod: "pod-a", generation: 1 };
    const guard = new LaggingFeedTracker("pod-a", () => row);
    const seenAtBuild: Array<number | undefined> = [];
    const sessions = createSessionManager({
      provisioner: {
        create: vi.fn(async (short: string) => ({ name: `conv-${short}`, namespace: "ns" })),
        resume: vi.fn(async (ref: unknown) => ref),
        suspend: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
      },
      store,
      selfPod: "pod-a",
      ownershipGuard: guard,
      bridgeFactory: ({ conversationId }: { conversationId: SessionId }) => {
        seenAtBuild.push(guard.observedGeneration(conversationId));
        return undefined;
      },
    } as never);
    const conv = await sessions.start("t1" as never);
    guard.observe(conv.id, row);
    await sessions.suspend(conv.id);
    seenAtBuild.length = 0;

    row = { hostPod: "pod-a", generation: 2 };
    await sessions.revive(conv.id);

    expect(new Set(seenAtBuild), "every bridge the revive builds must present generation 2").toEqual(new Set([2]));
  });
});
