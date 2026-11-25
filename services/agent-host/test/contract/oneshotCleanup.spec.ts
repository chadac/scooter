/** One-shot conversations: SessionManager fires onCleanupDue when the last run ends. */

import { describe, it, expect, vi } from "vitest";

import { createSessionManager, type SandboxProvisioner, type ConversationStore } from "../../src/session/manager.js";
import type { AguiEvent, SessionBridge } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";

const fakeProvisioner = () =>
  ({
    create: vi.fn(async (id: string) => ({ name: `conv-${id}`, namespace: "ns" })),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async (ref: SandboxRef) => ref),
    destroy: vi.fn(async (_ref: SandboxRef, _opts?: { volumes?: boolean }) => {}),
  }) satisfies SandboxProvisioner;

const inMemoryStore = (starred = new Set<string>()): ConversationStore & { oneshot: Set<string> } => {
  const logs = new Map<SessionId, AguiEvent[]>();
  const oneshot = new Set<string>();
  return {
    oneshot,
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
    setOneshot: async (id) => void oneshot.add(id),
    readRouterMeta: async (id) => ({ starred: starred.has(id) }),
  };
};

/** Fake bridges with test-controlled run and queue state. */
function controllableBridges() {
  const bridges = new Map<string, { running: boolean; queued: number; persist: (e: AguiEvent) => void }>();
  const factory = ({ conversationId }: { conversationId: string }) => {
    const listeners = new Set<(e: AguiEvent) => void>();
    const b = { running: false, queued: 0, persist: (e: AguiEvent) => listeners.forEach((l) => l(e)) };
    bridges.set(conversationId, b);
    return {
      onEvent: () => () => {},
      onPersist: (cb: (e: AguiEvent) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      prompt: async () => {},
      cancel: () => {},
      stop: vi.fn(async () => {}),
      start: async () => {},
      queueState: () => ({ running: b.running, currentRunMs: 0, queued: b.queued, maxQueuedPriority: 0 }),
      answerPermission: () => {},
    } as unknown as SessionBridge;
  };
  const emit = (id: string, e: Partial<AguiEvent>) => {
    const b = bridges.get(id)!;
    b.running = false;
    b.persist({ threadId: id, runId: "r1", ...e } as AguiEvent);
  };
  return { factory, bridges, emit };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function setup(starred?: Set<string>) {
  const provisioner = fakeProvisioner();
  const store = inMemoryStore(starred);
  const b = controllableBridges();
  const sessions = createSessionManager({ provisioner, store, bridgeFactory: b.factory });
  const due: SessionId[] = [];
  sessions.onCleanupDue((id) => due.push(id));
  return { provisioner, store, sessions, due, ...b };
}

describe("one-shot cleanup", () => {
  it("records oneshot at start and fires once the run finishes", async () => {
    const { sessions, store, due, emit } = setup();
    const conv = await sessions.start("t1", undefined, "alice", { oneshot: true });
    expect(sessions.get(conv.id)?.oneshot).toBe(true);
    expect(store.oneshot.has(conv.id)).toBe(true);

    emit(conv.id, { type: "RUN_FINISHED" });
    await settle();
    expect(due).toEqual([conv.id]);
  });

  it("fires on a run error too, but not on an interrupt pause", async () => {
    const { sessions, due, emit } = setup();
    const conv = await sessions.start("t1", undefined, "alice", { oneshot: true });
    emit(conv.id, { type: "RUN_FINISHED", outcome: { type: "interrupt" } } as Partial<AguiEvent>);
    await settle();
    expect(due).toEqual([]);
    emit(conv.id, { type: "RUN_ERROR" });
    await settle();
    expect(due).toEqual([conv.id]);
  });

  it("does nothing for a conversation that is not one-shot", async () => {
    const { sessions, due, emit } = setup();
    const conv = await sessions.start("t1", undefined, "alice");
    expect(sessions.get(conv.id)?.oneshot).toBeUndefined();
    emit(conv.id, { type: "RUN_FINISHED" });
    await settle();
    expect(due).toEqual([]);
  });

  it("waits while another turn is queued", async () => {
    const { sessions, due, emit, bridges } = setup();
    const conv = await sessions.start("t1", undefined, "alice", { oneshot: true });
    bridges.get(conv.id)!.queued = 1;
    emit(conv.id, { type: "RUN_FINISHED" });
    await settle();
    expect(due).toEqual([]);
  });

  it("never fires for a starred conversation", async () => {
    const { sessions, due, emit } = setup(new Set(["t1"]));
    const conv = await sessions.start("t1", undefined, "alice", { oneshot: true });
    emit(conv.id, { type: "RUN_FINISHED" });
    await settle();
    expect(due).toEqual([]);
  });

  it("end with volumes passes it to the provisioner", async () => {
    const { sessions, provisioner } = setup();
    const conv = await sessions.start("t1", undefined, "alice", { oneshot: true });
    await sessions.end(conv.id, { volumes: true });
    expect(provisioner.destroy).toHaveBeenCalledWith(conv.sandbox, { volumes: true });
    expect(sessions.get(conv.id)).toBeUndefined();
  });
});
