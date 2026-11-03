/**
 * Losing a conversation must stop this pod's run, not just fence its writes: the old owner
 * cancels (killing sandbox execs) and drops its bridge, and the new owner resumes a run
 * another pod started only after a hand-off grace.
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
    resume: vi.fn(async (ref: unknown) => ref),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  }) as never;

const memStore = (seed: AguiEvent[] = []) => {
  const logs = new Map<string, AguiEvent[]>([["t1", [...seed]]]);
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
    dump: () => logs.get("t1") ?? [],
  };
};

const fakeBridge = () => ({
  sessionId: "t1",
  start: vi.fn(async () => {}),
  prompt: vi.fn(async () => "run" as never),
  cancel: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  queueState: () => ({ running: true, currentRunMs: 1, queued: 0, maxQueuedPriority: 0 }),
  drainQueue: () => [],
  onPersist: () => () => {},
  onEvent: () => () => {},
  onTitle: () => () => {},
});

describe("relinquish — the old owner stops its run", () => {
  const setup = async () => {
    const guard = new OwnershipTracker("old-pod");
    guard.observe("t1", { hostPod: "old-pod", generation: 5 });
    const bridge = fakeBridge();
    const { store } = memStore();
    const provisioner = fakeProvisioner() as unknown as { suspend: ReturnType<typeof vi.fn> };
    const sessions = createSessionManager({
      provisioner,
      store,
      selfPod: "old-pod",
      ownershipGuard: guard,
      bridgeFactory: () => bridge as never,
    } as never);
    const conv = await sessions.start("t1" as never);
    return { guard, bridge, sessions, provisioner, id: conv.id as SessionId };
  };

  it("cancels (killing execs) and stops the bridge once the row names another pod @proves", async () => {
    const { guard, bridge, sessions, id } = await setup();
    expect(sessions.get(id)?.bridge).toBeDefined();
    guard.observe("t1", { hostPod: "new-pod", generation: 6 });

    await sessions.relinquish(id);

    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(sessions.get(id)?.bridge, "no new prompt may reach the dead bridge").toBeUndefined();
    expect(sessions.get(id)?.status).toBe("suspended");
  });

  it("leaves the Sandbox running for the new owner", async () => {
    const { guard, sessions, provisioner, id } = await setup();
    guard.observe("t1", { hostPod: "new-pod", generation: 6 });
    await sessions.relinquish(id);
    expect(provisioner.suspend).not.toHaveBeenCalled();
  });

  it("is a no-op when ownership came back before it ran", async () => {
    const { guard, bridge, sessions, id } = await setup();
    guard.observe("t1", { hostPod: "new-pod", generation: 6 });
    guard.observe("t1", { hostPod: "old-pod", generation: 7 });

    await sessions.relinquish(id);

    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(sessions.get(id)?.bridge).toBeDefined();
  });
});

describe("reconcileDanglingRun — hand-off grace before resuming another pod's run", () => {
  const FOREIGN_RUN: AguiEvent[] = [
    { type: "RUN_STARTED", threadId: "t1", runId: "r1", host: "old-pod", gen: 5 },
    { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "run: nix develop -c just db-generate" },
  ] as never;

  const setup = (graceMs: number) => {
    const guard = new OwnershipTracker("new-pod");
    guard.observe("t1", { hostPod: "new-pod", generation: 6 });
    const bridge = fakeBridge();
    const { store } = memStore(FOREIGN_RUN);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      ownershipGuard: guard,
      handoffGraceMs: graceMs,
      bridgeFactory: () => bridge as never,
    } as never);
    return { guard, bridge, sessions };
  };

  it("waits out the grace, then resumes exactly once @proves", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, sessions } = setup(5_000);
      const conv = await sessions.start("t1" as never);
      const done = sessions.reconcileDanglingRun(conv.id as SessionId, 6);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(bridge.prompt, "the old pod may still be executing it").not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await done;
      await vi.runAllTimersAsync();
      expect(bridge.prompt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume when this pod lost the conversation during the grace", async () => {
    vi.useFakeTimers();
    try {
      const { guard, bridge, sessions } = setup(5_000);
      const conv = await sessions.start("t1" as never);
      const done = sessions.reconcileDanglingRun(conv.id as SessionId, 6);
      guard.observe("t1", { hostPod: "third-pod", generation: 7 });
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(bridge.prompt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a fenced write stops the run, not just the write", () => {
  const FOREIGN_RUN: AguiEvent[] = [
    { type: "RUN_STARTED", threadId: "t1", runId: "r1", host: "dead-pod", gen: 1 },
  ] as never;

  /** This pod runs t1, but the row names `host`. */
  const setup = (host: string, seed: AguiEvent[] = []) => {
    const guard = new OwnershipTracker("this-pod");
    guard.observe("t1", { hostPod: host, generation: 2 });
    let persist: ((e: AguiEvent) => void) | undefined;
    const bridge = {
      ...fakeBridge(),
      onPersist: (cb: (e: AguiEvent) => void) => {
        persist = cb;
        return () => {};
      },
    };
    const { store } = memStore(seed);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "this-pod",
      ownershipGuard: guard,
      bridgeFactory: () => bridge as never,
    } as never);
    return { guard, bridge, store, sessions, emit: (e: AguiEvent) => persist?.(e) };
  };
  const text = { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hi" } as never as AguiEvent;

  it("a refusal also kills a bridge a suspend already detached, which may still be running @proves", async () => {
    const { bridge, sessions } = setup("this-pod");
    const conv = await sessions.start("t1" as never);
    await sessions.suspend(conv.id as SessionId);
    expect(sessions.get(conv.id as SessionId)?.bridge).toBeUndefined();

    await sessions.stopFencedRun(conv.id as SessionId);

    expect(bridge.cancel, "the detached run must be cancelled too").toHaveBeenCalledTimes(1);
  });

  it("a failed durable append kills the run @proves", async () => {
    const { bridge, store, sessions, emit } = setup("this-pod");
    (store as { appendEvent: unknown }).appendEvent = async () => {
      throw new Error("connection terminated");
    };
    await sessions.start("t1" as never);
    emit(text);
    await vi.waitFor(() => expect(bridge.cancel).toHaveBeenCalledTimes(1));
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it("a second reassignment away from this pod stops the run again @proves", async () => {
    const { guard, bridge, sessions, emit } = setup("other-pod");
    const conv = await sessions.start("t1" as never);
    emit(text);
    await vi.waitFor(() => expect(bridge.cancel).toHaveBeenCalledTimes(1));

    guard.observe("t1", { hostPod: "this-pod", generation: 3 });
    await sessions.revive(conv.id as SessionId);
    guard.observe("t1", { hostPod: "other-pod", generation: 4 });
    emit(text);

    await vi.waitFor(() => expect(bridge.cancel).toHaveBeenCalledTimes(2));
  });

  it("the first event the cache fences cancels the run, even on a pod that never owned it @proves", async () => {
    const { bridge, sessions, emit } = setup("other-pod");
    const conv = await sessions.start("t1" as never);
    emit(text);
    await vi.waitFor(() => expect(bridge.cancel).toHaveBeenCalledTimes(1));
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(sessions.get(conv.id as SessionId)?.bridge).toBeUndefined();
    emit(text);
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.cancel, "one stop, not one per dropped event").toHaveBeenCalledTimes(1);
  });

  it("a store-refused append stops the run even while the cache says this pod owns it", async () => {
    const { bridge, sessions } = setup("this-pod");
    const conv = await sessions.start("t1" as never);
    await sessions.stopFencedRun(conv.id as SessionId);
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    expect(sessions.get(conv.id as SessionId)?.bridge).toBeUndefined();
  });

  it("the restart sweep does not resume a conversation another pod owns", async () => {
    const other = setup("other-pod", FOREIGN_RUN);
    await other.sessions.start("t1" as never);
    await other.sessions.resumeInterrupted();
    expect(other.bridge.prompt).not.toHaveBeenCalled();

    const mine = setup("this-pod", FOREIGN_RUN);
    await mine.sessions.start("t1" as never);
    await mine.sessions.resumeInterrupted();
    expect(mine.bridge.prompt, "its own dangling run still resumes").toHaveBeenCalledTimes(1);
  });
});

describe("hand-off with stale orphans below the live run", () => {
  it("closes the orphans and still resumes the live run after the grace @proves", async () => {
    vi.useFakeTimers();
    try {
      const run = (runId: string, host: string): AguiEvent[] =>
        [{ type: "RUN_STARTED", threadId: "t1", runId, host, gen: 5 }] as never;
      const guard = new OwnershipTracker("new-pod");
      guard.observe("t1", { hostPod: "new-pod", generation: 6 });
      const bridge = fakeBridge();
      const { store, dump } = memStore([...run("old1", "dead-pod"), ...run("old2", "dead-pod"), ...run("live", "old-pod")]);
      const sessions = createSessionManager({
        provisioner: fakeProvisioner(),
        store,
        selfPod: "new-pod",
        ownershipGuard: guard,
        handoffGraceMs: 5_000,
        bridgeFactory: () => bridge as never,
      } as never);
      const conv = await sessions.start("t1" as never);
      const done = sessions.reconcileDanglingRun(conv.id as SessionId, 6);
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      await vi.runAllTimersAsync();
      const closedIds = dump().filter((e) => e.type === "RUN_FINISHED").map((e) => (e as { runId: string }).runId);
      expect(closedIds.sort()).toEqual(["old1", "old2"]);
      expect(bridge.prompt, "the live run must be resumed, not taken for settled").toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
