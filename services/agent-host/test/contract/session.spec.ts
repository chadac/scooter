/**
 * Tier 1 contract test — SessionManager lifecycle with fake provisioner + store.
 *
 * Proves: start (cold sandbox), prompt, suspend (keep handle), revive (replay
 * event log), end. RED against Design interfaces.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSessionManager,
  type SandboxProvisioner,
  type ConversationStore,
} from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
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
    // Delete-don't-tombstone: an ended conversation is GC'd from the list (and
    // its persisted state removed), so it no longer resolves.
    expect(sessions.get(conv.id)).toBeUndefined();
    expect(sessions.list()).toHaveLength(0);
  });

  it("the file store dedups + persists external resource links", async () => {
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      await store1.addLink!("c1", { source: "github", resourceType: "pull_request", url: "https://gh/pr/1", title: "PR #1" });
      // Same link again -> deduped.
      await store1.addLink!("c1", { source: "github", resourceType: "pull_request", url: "https://gh/pr/1", title: "PR #1" });
      await store1.addLink!("c1", { source: "slack", resourceType: "thread", title: "#eng thread" });
      expect(await store1.listLinks!("c1")).toHaveLength(2);

      // A fresh store over the same dir sees the persisted links (survive restart).
      const store2 = createFileConversationStore(root);
      const links = await store2.listLinks!("c1");
      expect(links.map((l) => l.source).sort()).toEqual(["github", "slack"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("conversations survive a restart (file store hydrate)", async () => {
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      // First "process": create two conversations + give one a title.
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      await m1.start("alpha");
      await m1.start("beta");
      m1.setTitle("alpha", "Refactor the parser");
      expect(m1.list()).toHaveLength(2);

      // Second "process": a fresh manager over the SAME store. hydrate() must
      // repopulate the list from disk (the in-memory entries are gone).
      const store2 = createFileConversationStore(root);
      const m2 = createSessionManager({ provisioner: fakeProvisioner(), store: store2 });
      expect(m2.list()).toHaveLength(0); // nothing in memory yet
      await m2.hydrate();

      const restored = m2.list();
      expect(restored).toHaveLength(2);
      const alpha = restored.find((c) => c.id === "alpha");
      expect(alpha?.title).toBe("Refactor the parser"); // persisted title
      expect(alpha?.status).toBe("suspended"); // resumable, not live
      expect(restored.find((c) => c.id === "beta")).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrate reconciles a still-running Sandbox as running so the idle sweep reclaims it", async () => {
    // The leak bug: after a restart the pods may NOT have been suspended, but
    // hydrate() assumed they were -> sweepIdle (running-only) never reclaimed
    // them. With reconcile(), a Sandbox whose pod is still up is tracked running.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("gamma");
      const sandboxName = m1.get(conv.id)!.sandbox.name; // conv-<shortId>

      // Fresh "process": its provisioner reports that conv's pod is STILL running.
      const prov2 = fakeProvisioner();
      prov2.reconcile = vi.fn(async () => [
        { ref: { name: sandboxName, namespace: "ns" }, running: true },
      ]);
      const m2 = createSessionManager({ provisioner: prov2, store: createFileConversationStore(root) });
      await m2.hydrate();

      // Reconciled as running (not assume-suspended), with the real namespace.
      expect(m2.get(conv.id)?.status).toBe("running");

      // ...so the idle sweep can now actually suspend it (the leak is reclaimed).
      const swept = await m2.sweepIdle(0); // 0 idle threshold -> everything idle
      expect(swept).toContain(conv.id);
      expect(prov2.suspend).toHaveBeenCalledOnce();
      expect(m2.get(conv.id)?.status).toBe("suspended");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prompting a hydrated-but-running conversation revives it (builds the bridge)", async () => {
    // Regression: hydrate() marks a still-running conversation 'running' (pod up)
    // but it has NO bridge in this process. prompt() must revive on !bridge — NOT
    // gate revive on status!=="running", or bridge?.prompt() silently no-ops and
    // the agent never runs (the second-!scooter-does-nothing symptom).
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("delta");
      const sandboxName = m1.get(conv.id)!.sandbox.name;

      // Fresh process: a recording bridge so we can see prompt() reach it.
      const prompts: string[] = [];
      const bridgeFactory = () =>
        ({
          start: vi.fn(async () => {}),
          prompt: vi.fn(async ({ text }: { text: string }) => {
            prompts.push(text);
            return "run-x";
          }),
          stop: vi.fn(async () => {}),
          onEvent: () => () => {},
          onPersist: () => () => {},
          onTitle: () => () => {},
        }) as never;
      const prov2 = fakeProvisioner();
      prov2.reconcile = vi.fn(async () => [
        { ref: { name: sandboxName, namespace: "ns" }, running: true },
      ]);
      const m2 = createSessionManager({
        provisioner: prov2,
        store: createFileConversationStore(root),
        bridgeFactory,
      });
      await m2.hydrate();
      expect(m2.get(conv.id)?.status).toBe("running"); // pod up, but no bridge

      // The webhook path: prompt the existing conversation by thread id.
      await m2.promptByThread("delta", "second !scooter mention");

      // It revived (built the bridge) and the prompt reached the agent.
      expect(prompts).toContain("second !scooter mention");
      // Let the fire-and-forget activity write settle before teardown deletes the
      // store dir (else a late recordActivity mkdir races rmSync -> ENOENT).
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ended conversations do NOT come back after a restart (persisted state removed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      await m1.start("keep");
      const gone = await m1.start("gone");
      await m1.end(gone.id);
      expect(m1.list().map((c) => c.id)).toEqual(["keep"]); // gone is GC'd now

      // A fresh process hydrates from disk: the ended conversation must be gone,
      // not resurrected as a "suspended" tombstone.
      const m2 = createSessionManager({
        provisioner: fakeProvisioner(),
        store: createFileConversationStore(root),
      });
      await m2.hydrate();
      expect(m2.list().map((c) => c.id)).toEqual(["keep"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records last-activity metadata and persists it via the store", async () => {
    const provisioner = fakeProvisioner();
    const store = inMemoryStore();
    store.recordActivity = vi.fn(async () => {});
    const sessions = createSessionManager({ provisioner, store });

    const conv = await sessions.start("thread-1");
    const t0 = sessions.get(conv.id)!.lastActivityAt;
    expect(t0).toBeGreaterThan(0);

    await sessions.promptByThread("thread-1", "hello");

    expect(sessions.get(conv.id)!.lastActivityAt).toBeGreaterThanOrEqual(t0);
    expect(store.recordActivity).toHaveBeenCalledWith(conv.id, expect.any(Number));
  });

  it("sweepIdle() suspends only running conversations idle past the threshold", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const provisioner = fakeProvisioner();
      const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
      const idle = await sessions.start("idle-thread"); // stamped at t=0

      vi.setSystemTime(9 * 60_000); // 9 min later
      const fresh = await sessions.start("fresh-thread"); // stamped at t=9min

      // At t=10min, idle is 10min old, fresh is 1min old; threshold is 5min.
      const suspended = await sessions.sweepIdle(5 * 60_000, 10 * 60_000);

      expect(suspended).toEqual([idle.id]);
      expect(sessions.get(idle.id)?.status).toBe("suspended");
      expect(sessions.get(fresh.id)?.status).toBe("running");
      expect(provisioner.suspend).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweepIdle() ignores already-suspended conversations", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const conv = await sessions.start("thread-1");
    await sessions.suspend(conv.id);
    (provisioner.suspend as ReturnType<typeof vi.fn>).mockClear();

    // idleMs 0 + now in the future → everything "idle", but only running ones sweep.
    const suspended = await sessions.sweepIdle(0, conv.lastActivityAt + 1);

    expect(suspended).toEqual([]);
    expect(provisioner.suspend).not.toHaveBeenCalled();
  });
});
