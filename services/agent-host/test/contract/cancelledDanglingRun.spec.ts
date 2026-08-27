/**
 * Tier 1 — a user Stop that races the owner pod's death must STAY stopped.
 *
 * The cluster shape (e2e-full run 33015148191): Stop clicked, the scale-down kills
 * the owner before RUN_FINISHED lands, the next owner sees a dangling run. Before
 * the persisted CANCEL_REQUESTED marker, its only move was a resume nudge — which
 * resurrects work the user killed and leaves the browser's run bar up through the
 * whole resurrection. Now revive TERMINATES a cancelled dangling run by appending
 * the RUN_FINISHED{cancelled} the dead pod owed, which the reconnected stream
 * replays to the UI.
 */

import { describe, it, expect, vi } from "vitest";

import { createSessionManager } from "../../src/session/manager.js";
import type { ConversationStore, SessionId } from "../../src/session/manager.js";
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

const DEAD_HOST_RUN: AguiEvent[] = [
  { type: "RUN_STARTED", threadId: "t1", runId: "r1", host: "dead-pod", gen: 1 },
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "run: sleep 20" },
] as never;

const CANCEL: AguiEvent = { type: "CANCEL_REQUESTED", threadId: "t1", runId: "r1" } as never;

describe("a cancelled dangling run is TERMINATED on reassignment, not resumed", () => {
  it("revive appends the RUN_FINISHED{cancelled} the dead pod owed @proves", async () => {
    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN, CANCEL]);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      hydrateFromMirror: async () => true,
    } as never);
    const conv = await sessions.start("t1" as never);

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    const tail = dump().at(-1) as { type: string; cancelled?: boolean; runId?: string };
    expect(tail).toMatchObject({ type: "RUN_FINISHED", runId: "r1", cancelled: true });
  });

  it("an UNcancelled dangling run gets no synthetic terminal (the resume path owns it)", async () => {
    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN]);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      hydrateFromMirror: async () => true,
    } as never);
    const conv = await sessions.start("t1" as never);
    const before = dump().filter((e) => (e as { type: string }).type === "RUN_FINISHED").length;

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    const after = dump().filter((e) => (e as { type: string }).type === "RUN_FINISHED").length;
    expect(after, "no synthetic terminal for a run that should RESUME").toBe(before);
  });
});

describe("the LAZY adoption path settles a dangling run (lost revive push)", () => {
  // The controller's revive push is fire-and-forget; when it dies with the old pod,
  // ensureReadable (the UI's first read through the router) is where the new owner
  // first materializes the conversation — and before this fix it adopted the entry
  // WITHOUT settling the stranded run, which then spun "Working…" forever
  // (the pod-move story, CI run 33024754713).
  it("ensureReadable terminates a cancelled dangling run it adopts @proves", async () => {
    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN, CANCEL]);
    (store as { listConversations?: unknown }).listConversations = async () => [
      { id: "t1", threadId: "t1", title: "", createdAt: 0, lastActivityAt: 0 },
    ];
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      hydrateFromMirror: async () => true,
    } as never);

    expect(await sessions.ensureReadable("t1" as SessionId)).toBe(true);
    // fire-and-forget settlement — give the microtask a beat
    await new Promise((r) => setTimeout(r, 50));

    const tail = dump().at(-1) as { type: string; cancelled?: boolean; runId?: string };
    expect(tail).toMatchObject({ type: "RUN_FINISHED", runId: "r1", cancelled: true });
  });
});

describe("the ownership WATCH settles a stranded run (the production shape)", () => {
  // THE test that would have caught both earlier misses in seconds instead of two
  // 15-minute deploy-validate rounds: the entry ALREADY EXISTS on the new owner
  // (the #297 hydrate cascade puts every conversation's entry on every pod), the
  // revive push never arrives, and the ONLY signal of the reassignment is the
  // ownership watch. Settlement must fire from that signal alone.
  it("a watch-delivered gain terminates the cancelled stranded run @proves", async () => {
    const { OwnershipTracker } = await import("../../src/session/ownershipGuard.js");
    const tracker = new OwnershipTracker("new-pod");
    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN, CANCEL]);
    (store as { listConversations?: unknown }).listConversations = async () => [
      { id: "t1", threadId: "t1", title: "", createdAt: 0, lastActivityAt: 0 },
    ];
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      ownershipGuard: tracker,
      hydrateFromMirror: async () => true,
    } as never);
    // the same wiring index.ts does
    tracker.onGained = (id, gen) => {
      void sessions.reconcileDanglingRun(id as SessionId, gen);
    };
    // PRODUCTION ORDER: the old pod owns it when the hydrate cascade runs, so the
    // fence blocks every hydration-path settlement — exactly why the two earlier
    // hooks never fired in the deployed validation rounds.
    tracker.observe("t1", { hostPod: "dead-pod", generation: 1 });
    expect(await sessions.ensureReadable("t1" as SessionId)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(
      dump().some((e) => (e as { type: string }).type === "RUN_FINISHED"),
      "fenced hydration must NOT settle while another pod owns the conversation",
    ).toBe(false);
    // The reassignment arrives ONLY via the watch — the one signal that always fires.
    tracker.observe("t1", { hostPod: "new-pod", generation: 2 });
    await new Promise((r) => setTimeout(r, 50));

    const tail = dump().at(-1) as { type: string; cancelled?: boolean; runId?: string };
    expect(tail).toMatchObject({ type: "RUN_FINISHED", runId: "r1", cancelled: true });
  });
});
