/**
 * Tier 1 — the controller's revive push must beat its own watch event.
 *
 * The cluster shape (e2e-full run 33024754713, the conversation-moves-pods story):
 * the controller writes hostPod=<new pod> generation=2 and POSTs /internal/revive
 * in the same tick. The new pod's CR watch has not yet delivered that write, so its
 * ownership cache still names the DEAD pod — and reviveFromMirror's fence read that
 * stale cache as "another pod owns it" and dropped the push. Silently, and nothing
 * re-pushes: the dangling run was never resumed nor terminated, and the browser sat
 * "Working…" until the 180s budget died.
 *
 * The fix: a push whose generation is NEWER than anything the watch has shown is a
 * stale CACHE, not a stale push — adopt the assignment and proceed. A push at or
 * below the observed generation stays fenced (that one really is stale).
 */

import { describe, it, expect, vi } from "vitest";

import { createSessionManager } from "../../src/session/manager.js";
import type { ConversationStore, SessionId } from "../../src/session/manager.js";
import { OwnershipTracker } from "../../src/session/ownershipGuard.js";
import type { AguiEvent } from "../../src/bridge.js";

const fakeProvisioner = () =>
  ({
    create: vi.fn(async (short: string) => ({ name: `conv-${short}`, namespace: "ns" })),
    ensure: vi.fn(async (short: string) => ({ name: `conv-${short}`, namespace: "ns" })),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  }) as never;

const seededStore = (id: string, events: AguiEvent[]) => {
  const logs = new Map<string, AguiEvent[]>([[id, [...events]]]);
  return {
    store: {
      appendEvent: async (cid: string, e: AguiEvent) => {
        (logs.get(cid) ?? logs.set(cid, []).get(cid)!).push(e);
      },
      async *readEvents(cid: string) {
        yield* logs.get(cid) ?? [];
      },
      gooseStatePath: (cid: string) => `/state/${cid}/goose`,
    } as never as ConversationStore,
    dump: () => logs.get(id) ?? [],
  };
};

/** A run the dead pod started and never finished, plus the user's Stop marker —
 *  so the correct revive outcome is an APPENDED terminal, observable in the log. */
const DEAD_HOST_RUN: AguiEvent[] = [
  { type: "RUN_STARTED", threadId: "t1", runId: "r1", host: "dead-pod", gen: 1 },
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "run: sleep 20" },
  { type: "CANCEL_REQUESTED", threadId: "t1", runId: "r1" },
] as never;

describe("reviveFromMirror vs a lagging ownership watch", () => {
  it("a push NEWER than the cached view is honored, not fenced (stale cache ≠ stale push) @proves", async () => {
    const guard = new OwnershipTracker("new-pod");
    guard.observe("t1", { hostPod: "dead-pod", generation: 1 }); // the watch has NOT seen gen 2 yet

    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN]);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      ownershipGuard: guard,
      hydrateFromMirror: async () => true,
    } as never);
    const conv = await sessions.start("t1" as never);

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    const tail = dump().at(-1) as { type: string; cancelled?: boolean; runId?: string };
    expect(tail, "the push must get through and terminate the cancelled dangling run").toMatchObject({
      type: "RUN_FINISHED",
      runId: "r1",
      cancelled: true,
    });
    expect(guard.canWrite(conv.id as SessionId), "the adopted assignment must unfence appends").toBe(true);
  });

  it("a push at or below the OBSERVED generation stays fenced (genuinely stale)", async () => {
    const guard = new OwnershipTracker("new-pod");
    guard.observe("t1", { hostPod: "third-pod", generation: 3 }); // the CR moved on past this push

    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN]);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      ownershipGuard: guard,
      hydrateFromMirror: async () => true,
    } as never);
    const conv = await sessions.start("t1" as never);
    const before = dump().length;

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    expect(dump().length, "a stale push must not touch the log third-pod now drives").toBe(before);
    expect(guard.canWrite(conv.id as SessionId), "the stale push must not steal ownership").toBe(false);
  });
});
