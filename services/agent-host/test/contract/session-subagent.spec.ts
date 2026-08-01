/**
 * Tier 1 contract — subagents at the SessionManager level (RED-FIRST; see
 * todo/docs/SUBAGENTS.md).
 *
 * A subagent is a full conversation that SHARES the parent's sandbox pod
 * (SandboxRef) and carries a `parentId`. So spawnChild:
 *   - does NOT provision a new sandbox (reuses the parent's ref),
 *   - stamps parentId + inherits the parent's owner,
 *   - is a normal conversation otherwise (own id/bridge/event log).
 * Lifecycle: end(id) cascade-ends the whole subtree (all share ONE root pod); a
 * conversation with a live descendant is NOT idle-swept. Subagents are
 * MULTI-LEVEL (a subagent may spawn its own).
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

describe("SessionManager subagents", () => {
  it("spawnChild reuses the parent's sandbox (no new provision) + sets parentId + inherits owner", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });

    const parent = await sessions.start("parent-1", undefined, "alice");
    expect(provisioner.create).toHaveBeenCalledOnce(); // the parent's cold sandbox

    const child = await sessions.spawnChild(parent.id, "child-1", { prompt: "research X" });

    // The child is a distinct conversation...
    expect(child.id).toBe("child-1");
    expect(child.id).not.toBe(parent.id);
    // ...that SHARES the parent's sandbox ref (NO second provision)...
    expect(provisioner.create).toHaveBeenCalledOnce();
    expect(child.sandbox).toEqual(parent.sandbox);
    // ...carries the parent link + inherits the owner.
    expect(child.parentId).toBe(parent.id);
    expect(child.owner).toBe("alice");
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
    // Still ONE sandbox for the whole tree (only the root ever provisioned).
    expect(provisioner.create).toHaveBeenCalledOnce();
    expect(grandchild.sandbox).toEqual(root.sandbox);
  });

  it("end(id) cascade-ends the whole subtree (all share the root pod)", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const root = await sessions.start("root", undefined, "alice");
    await sessions.spawnChild(root.id, "c1", { prompt: "a" });
    await sessions.spawnChild("c1", "gc1", { prompt: "deeper" }); // grandchild
    await sessions.spawnChild(root.id, "c2", { prompt: "b" });

    await sessions.end(root.id);

    // The whole subtree is ended + removed (end is delete-don't-tombstone), so
    // none of the descendants remain get()-able.
    for (const id of ["root", "c1", "gc1", "c2"]) expect(sessions.get(id)).toBeUndefined();
    // The shared sandbox is torn down exactly once (the root owns it; children
    // share it and must NOT re-destroy).
    expect(provisioner.destroy).toHaveBeenCalledOnce();
  });

  it("does NOT idle-sweep a conversation with a live DESCENDANT (recursively)", async () => {
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
    const root = await sessions.start("root", undefined, "alice");
    await sessions.spawnChild(root.id, "c1", { prompt: "a" });
    await sessions.spawnChild("c1", "gc1", { prompt: "deeper" }); // a live grandchild

    // Force an idle sweep with a 0ms threshold.
    const suspended = await sessions.sweepIdle(0);
    // The root + the middle child both have a live descendant → neither is swept
    // (the shared pod can't drop while any descendant runs).
    expect(suspended).not.toContain(root.id);
    expect(suspended).not.toContain("c1");
    expect(sessions.get(root.id)?.status).toBe("running");
  });
});
