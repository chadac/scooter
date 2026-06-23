/**
 * Tier 1 contract test — SessionManager lifecycle with fake provisioner + store.
 *
 * Proves: start (cold sandbox), prompt, suspend (keep handle), revive (replay
 * event log), end. RED against Design interfaces.
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
  const refs = new Map<string, SandboxRef>();
  return {
    create: vi.fn(async (id) => {
      const ref = { name: `conv-${id}`, namespace: "ns" };
      refs.set(id, ref);
      return ref;
    }),
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

describe("SessionManager", () => {
  it("start() provisions a cold sandbox and a running conversation", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });

    const conv = await sessions.start("thread-1");

    expect(provisioner.create).toHaveBeenCalledOnce();
    expect(conv.status).toBe("running");
    expect(conv.sandbox.name).toMatch(/^conv-/);
  });

  it("suspend() keeps the conversation handle (suspend-don't-delete)", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const conv = await sessions.start("thread-1");

    await sessions.suspend(conv.id);

    expect(provisioner.suspend).toHaveBeenCalledOnce();
    expect(provisioner.destroy).not.toHaveBeenCalled();
    expect(sessions.get(conv.id)?.status).toBe("suspended");
  });

  it("revive() resumes the same sandbox and replays the event log", async () => {
    const provisioner = fakeProvisioner();
    const store = inMemoryStore();
    const sessions = createSessionManager({ provisioner, store });
    const conv = await sessions.start("thread-1");
    await store.appendEvent(conv.id, { type: "RUN_STARTED", threadId: "thread-1", runId: "r1" });
    await sessions.suspend(conv.id);

    const revived = await sessions.revive(conv.id);

    expect(provisioner.resume).toHaveBeenCalledOnce();
    expect(revived.sandbox.name).toBe(conv.sandbox.name); // same body
    expect(revived.status).toBe("running");
  });

  it("end() destroys the sandbox and GCs the conversation", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const conv = await sessions.start("thread-1");

    await sessions.end(conv.id);

    expect(provisioner.destroy).toHaveBeenCalledOnce();
    expect(sessions.get(conv.id)?.status).toBe("ended");
  });
});
