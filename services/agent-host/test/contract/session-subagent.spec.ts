/**
 * Contract tests for subagents at the SessionManager level. A subagent is a full
 * conversation that shares the parent's sandbox pod and carries a `parentId`, so
 * spawnChild provisions nothing new and inherits the owner. end(id) cascade-ends
 * the whole subtree, and a conversation with a live descendant is not idle-swept.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createSessionManager,
  type SandboxProvisioner,
  type ConversationStore,
} from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";

const fakeProvisioner = (): SandboxProvisioner => {
  return {
    create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" })),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async (ref) => ref),
    destroy: vi.fn(async () => {}),
  };
};

const inMemoryStore = (): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
  };
};

/** A minimal fake bridge whose RUN_FINISHED a test can drive. */
function fakeBridgeFactory() {
  const bridges = new Map<string, { emit: (e: AguiEvent) => void }>();
  const factory = ({ conversationId }: { conversationId: string }) => {
    const listeners = new Set<(e: AguiEvent) => void>();
    bridges.set(conversationId, { emit: (e) => listeners.forEach((l) => l(e)) });
    return {
      onEvent: (cb: (e: AguiEvent) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
      onPersist: () => () => {},
      prompt: async () => {},
      cancel: () => {},
      stop: async () => {},
      start: async () => {},
      queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
      answerPermission: () => {},
    } as unknown as import("../../src/bridge.js").SessionBridge;
  };
  return { factory, finish: (id: string) => bridges.get(id)?.emit({ type: "RUN_FINISHED", threadId: id, runId: "r1" } as AguiEvent) };
}

describe("SessionManager subagents", () => {
  it("spawnChild reuses the parent's sandbox (no new provision) + sets parentId + inherits owner", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });

    const parent = await sessions.start("parent-1", undefined, "alice");
    expect(provisioner.create).toHaveBeenCalledOnce();

    const child = await sessions.spawnChild(parent.id, "child-1", { prompt: "research X" });

    expect(child.id).toBe("child-1");
    expect(child.id).not.toBe(parent.id);
    expect(provisioner.create).toHaveBeenCalledOnce();
    expect(child.sandbox).toEqual(parent.sandbox);
    expect(child.parentId).toBe(parent.id);
    expect(child.owner).toBe("alice");
  });

  it("spawnChild RETURNS while the child is still working (it must not await the run)", async () => {
    // SessionBridge.prompt() resolves when the run completes, so this uses a child whose run never finishes.
    const provisioner = fakeProvisioner();
    let promptCalls = 0;
    const neverFinishes = () =>
      ({
        onEvent: () => () => {},
        onPersist: () => () => {},
        prompt: () => {
          promptCalls++;
          return new Promise<void>(() => {});
        },
        cancel: () => {},
        stop: async () => {},
        start: async () => {},
        queueState: () => ({ running: true, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
        answerPermission: () => {},
      }) as unknown as import("../../src/bridge.js").SessionBridge;

    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      bridgeFactory: neverFinishes,
    });
    const parent = await sessions.start("p", undefined, "alice");

    const child = await Promise.race([
      sessions.spawnChild(parent.id, "c-bg", { prompt: "long job" }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error("spawnChild BLOCKED on the child's run")), 1_000)),
    ]);

    expect((child as { id: string }).id).toBe("c-bg");
    expect(promptCalls, "the child's work must still be kicked off").toBe(1);
    expect(sessions.get("c-bg" as SessionId)?.parentId).toBe(parent.id);
  });

  it("lists a parent's children via parentId", async () => {
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
    const parent = await sessions.start("p", undefined, "alice");
    await sessions.spawnChild(parent.id, "c1", { prompt: "a" });
    await sessions.spawnChild(parent.id, "c2", { prompt: "b" });

    const kids = sessions.list().filter((c) => c.parentId === parent.id).map((c) => c.id).sort();
    expect(kids).toEqual(["c1", "c2"]);
  });

  it("a subagent CAN spawn its own subagent (multi-level), sharing the root pod", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const root = await sessions.start("root", undefined, "alice");
    const child = await sessions.spawnChild(root.id, "c1", { prompt: "a" });
    const grandchild = await sessions.spawnChild(child.id, "gc1", { prompt: "deeper" });

    expect(grandchild.parentId).toBe(child.id);
    expect(provisioner.create).toHaveBeenCalledOnce();
    expect(grandchild.sandbox).toEqual(root.sandbox);
  });

  it("end(id) cascade-ends the whole subtree (all share the root pod)", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const root = await sessions.start("root", undefined, "alice");
    await sessions.spawnChild(root.id, "c1", { prompt: "a" });
    await sessions.spawnChild("c1", "gc1", { prompt: "deeper" });
    await sessions.spawnChild(root.id, "c2", { prompt: "b" });

    await sessions.end(root.id);

    for (const id of ["root", "c1", "gc1", "c2"]) expect(sessions.get(id)).toBeUndefined();
    // The root owns the shared sandbox, so it is torn down exactly once.
    expect(provisioner.destroy).toHaveBeenCalledOnce();
  });

  it("does NOT idle-sweep a conversation with a live DESCENDANT (recursively)", async () => {
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
    const root = await sessions.start("root", undefined, "alice");
    await sessions.spawnChild(root.id, "c1", { prompt: "a" });
    await sessions.spawnChild("c1", "gc1", { prompt: "deeper" });

    const suspended = await sessions.sweepIdle(0);
    // The root and the middle child both have a live descendant.
    expect(suspended).not.toContain(root.id);
    expect(suspended).not.toContain("c1");
    expect(sessions.get(root.id)?.status).toBe("running");
  });

  it("idle-sweeps a parent whose only subagent is already suspended (issue #1094)", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const root = await sessions.start("root", undefined, "alice");
    await sessions.spawnChild(root.id, "c1", { prompt: "a" });

    expect(await sessions.sweepIdle(0)).toEqual(["c1"]);
    expect(sessions.get("c1")?.status).toBe("suspended");
    expect(await sessions.sweepIdle(0)).toEqual([root.id]);
    expect(provisioner.suspend).toHaveBeenCalledOnce();
  });

  it("onSubagentComplete fires (subagentId + parentId) when a subagent's run FINISHES — event-driven, no poll", async () => {
    const bf = fakeBridgeFactory();
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store: inMemoryStore(),
      bridgeFactory: bf.factory,
    });
    const parent = await sessions.start("p", undefined, "alice");
    const child = await sessions.spawnChild(parent.id, "c1", { prompt: "a" });

    const fired: Array<{ subagentId: string; parentId: string }> = [];
    sessions.onSubagentComplete((subagentId, parentId) => fired.push({ subagentId, parentId }));

    bf.finish(child.id);
    expect(fired).toEqual([{ subagentId: "c1", parentId: parent.id }]);
  });
});

describe("a subagent never owns a sandbox (the 2026-10-19 subagent storm)", () => {
  it("suspending a subagent leaves its parent's shared sandbox running", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const root = await sessions.start("root", undefined, "alice");
    await sessions.spawnChild(root.id, "c1", { prompt: "a" });

    await sessions.suspend("c1");

    expect(provisioner.suspend).not.toHaveBeenCalled();
    expect(sessions.get("c1")?.status).toBe("suspended");
    expect(sessions.get(root.id)?.status).toBe("running");
  });

  it("THE BUG: reviving a subagent revives its root and reuses the root's sandbox, provisioning nothing @proves", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const root = await sessions.start("root", undefined, "alice");
    await sessions.spawnChild(root.id, "c1", { prompt: "a" });
    await sessions.suspend("c1");
    await sessions.suspend(root.id);

    await sessions.revive("c1");

    expect(provisioner.create).toHaveBeenCalledOnce(); // the root's start, nothing since
    expect(provisioner.resume).toHaveBeenCalledOnce();
    expect(vi.mocked(provisioner.resume).mock.calls[0][0]).toEqual(root.sandbox);
    expect(sessions.get(root.id)?.status).toBe("running");
    expect(sessions.get("c1")?.sandbox).toEqual(root.sandbox);
  });

  it("reviving a nested subagent walks to the root", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const root = await sessions.start("root", undefined, "alice");
    await sessions.spawnChild(root.id, "c1", { prompt: "a" });
    await sessions.spawnChild("c1", "gc1", { prompt: "b" });
    await sessions.suspend("gc1");

    await sessions.revive("gc1");

    expect(provisioner.create).toHaveBeenCalledOnce();
    expect(sessions.get("gc1")?.sandbox).toEqual(root.sandbox);
  });
});

describe("sessions (kind: session)", () => {
  it("a session starts idle: no first prompt, kind and parent set, parent's sandbox shared", async () => {
    const prompts: string[] = [];
    const bf = fakeBridgeFactory();
    const factory = (args: { conversationId: string }) => {
      const b = bf.factory(args);
      return { ...b, prompt: async (p: { text: string }) => void prompts.push(p.text) } as typeof b;
    };
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore(), bridgeFactory: factory });
    const parent = await sessions.start("p", undefined, "alice");

    const ses = await sessions.spawnChild(parent.id, "s1", { kind: "session" });

    expect(prompts).toEqual([]);
    expect(ses).toMatchObject({ kind: "session", parentId: parent.id, owner: "alice", title: "New chat" });
    expect(ses.sandbox).toEqual(parent.sandbox);
    expect(provisioner.create).toHaveBeenCalledOnce();
  });

  it("the agent's <title> names a session after its creator's prefix, once", async () => {
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: fakeBridgeFactory().factory });
    const parent = await sessions.start("p", undefined, "alice");
    const ses = await sessions.spawnChild(parent.id, "s1", { kind: "session", title: "vscode: New chat" });

    await sessions.setTitle(ses.id, "Fix the login redirect");
    await sessions.setTitle(ses.id, "Something else");

    expect(sessions.get(ses.id)?.title).toBe("vscode: Fix the login redirect");
  });

  it("a session's finished run is never reported to its parent", async () => {
    const bf = fakeBridgeFactory();
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: bf.factory });
    const parent = await sessions.start("p", undefined, "alice");
    await sessions.spawnChild(parent.id, "s1", { kind: "session" });
    const fired: string[] = [];
    sessions.onSubagentComplete((id) => fired.push(id));

    bf.finish("s1");

    expect(fired).toEqual([]);
  });
});
