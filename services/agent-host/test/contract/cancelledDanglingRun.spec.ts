/**
 * A user Stop that races the owner pod's death stays stopped: when the next owner
 * finds a dangling run with a persisted CANCEL_REQUESTED marker, it appends the
 * RUN_FINISHED{cancelled} the dead pod owed instead of resuming the run.
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
    } as never);
    const conv = await sessions.start("t1" as never);
    const before = dump().filter((e) => (e as { type: string }).type === "RUN_FINISHED").length;

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    const after = dump().filter((e) => (e as { type: string }).type === "RUN_FINISHED").length;
    expect(after, "no synthetic terminal for a run that should RESUME").toBe(before);
  });
});

describe("the LAZY adoption path settles a dangling run (lost revive push)", () => {
  // When the controller's revive push is lost, ensureReadable is where the new owner first materializes the conversation.
  it("ensureReadable terminates a cancelled dangling run it adopts @proves", async () => {
    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN, CANCEL]);
    (store as { listConversations?: unknown }).listConversations = async () => [
      { id: "t1", threadId: "t1", title: "", createdAt: 0, lastActivityAt: 0 },
    ];
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
    } as never);

    expect(await sessions.ensureReadable("t1" as SessionId)).toBe(true);
    // Settlement is fire-and-forget.
    await new Promise((r) => setTimeout(r, 50));

    const tail = dump().at(-1) as { type: string; cancelled?: boolean; runId?: string };
    expect(tail).toMatchObject({ type: "RUN_FINISHED", runId: "r1", cancelled: true });
  });
});

describe("the ownership WATCH settles a stranded run (the production shape)", () => {
  // The entry already exists on the new owner and the ownership watch is the only signal of the reassignment.
  it("a watch-delivered gain terminates the cancelled stranded run @proves", async () => {
    const { OwnershipTracker } = await import("../../src/session/ownershipGuard.js");
    const tracker = new OwnershipTracker("new-pod");
    // The dead pod's events are visible to the new owner through the shared store, but nothing is hydrated locally.
    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN, CANCEL]);
    (store as { listConversations?: unknown }).listConversations = async () => [
      { id: "t1", threadId: "t1", title: "", createdAt: 0, lastActivityAt: 0 },
    ];
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      ownershipGuard: tracker,
    } as never);
    // The same wiring index.ts does.
    tracker.onGained = (id, gen) => {
      void sessions.reconcileDanglingRun(id as SessionId, gen);
    };
    // The gain arrives before any UI read has hydrated this pod, so settlement must pull the mirror itself.
    tracker.observe("t1", { hostPod: "dead-pod", generation: 1 });
    tracker.observe("t1", { hostPod: "new-pod", generation: 2 });
    await new Promise((r) => setTimeout(r, 80));

    const tail = dump().at(-1) as { type: string; cancelled?: boolean; runId?: string };
    expect(tail).toMatchObject({ type: "RUN_FINISHED", runId: "r1", cancelled: true });
  });
});

describe("a run this host is still executing is never resumed as dangling", () => {
  // Without POD_NAME, RUN_STARTED is unstamped and reads as foreign.
  const liveBridge = (running: boolean) => {
    const prompts: string[] = [];
    const bridge = {
      sessionId: "s1",
      start: async () => {},
      prompt: async (input: { text: string }) => {
        prompts.push(input.text);
        return "r-next";
      },
      cancel: async () => {},
      stop: async () => {},
      queueState: () => ({ running, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
      drainQueue: () => [],
      shouldYieldToQueue: () => false,
      onEvent: () => () => {},
      onPersist: () => () => {},
      onTitle: () => () => {},
    };
    return { bridge, prompts };
  };
  const UNSTAMPED_RUN: AguiEvent[] = [{ type: "RUN_STARTED", threadId: "t1", runId: "r1" }] as never;

  it("the first prompt's own unstamped RUN_STARTED gets no resume nudge @proves", async () => {
    const { store } = seededStore("t1", []);
    const { bridge, prompts } = liveBridge(true);
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store, bridgeFactory: () => bridge } as never);
    const conv = await sessions.start("t1" as never);
    // The adoption check sees the live run's own marker.
    await store.appendEvent(conv.id as SessionId, UNSTAMPED_RUN[0]);

    await sessions.reconcileDanglingRun(conv.id as SessionId);
    await new Promise((r) => setTimeout(r, 20));

    expect(prompts, "a live run must not be re-driven").toEqual([]);
  });

  it("an idle bridge still resumes a stranded unstamped run", async () => {
    const { store } = seededStore("t1", []);
    const { bridge, prompts } = liveBridge(false);
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store, bridgeFactory: () => bridge } as never);
    const conv = await sessions.start("t1" as never);
    await store.appendEvent(conv.id as SessionId, UNSTAMPED_RUN[0]);

    await sessions.reconcileDanglingRun(conv.id as SessionId);
    await new Promise((r) => setTimeout(r, 20));

    expect(prompts.length, "a stranded run is resumed once").toBe(1);
  });
});
