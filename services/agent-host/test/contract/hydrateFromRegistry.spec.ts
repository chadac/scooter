/**
 * Contract tests for hydrate() driven by the conversation registry (the conversations row),
 * the source of truth. LOCAL_STATE_PATH is an emptyDir that a restart wipes, so every test
 * here gives the second manager an empty local store and expects the registry list to populate it.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createSessionManager,
  shortId,
  type SandboxProvisioner,
  type ConversationStore,
} from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";
import type { ConversationRecord } from "../../src/session/conversationRegistry.js";

const SELF = "agent-host-abc";

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

/** In-memory store with meta persistence, so "the local cache survived" is expressible. */
const inMemoryStore = (): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  const metas = new Map<string, Record<string, unknown>>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
    saveMeta: async (m: { id: string }) => {
      metas.set(m.id, m as Record<string, unknown>);
    },
    listConversations: async () => [...metas.values()],
  } as ConversationStore;
};

/** A registry serving `records` as the row list. */
const registryWith = (records: ConversationRecord[], opts: { listError?: Error } = {}) => ({
  register: vi.fn(async () => {}),
  setPhase: vi.fn(async () => {}),
  list: vi.fn(async () => {
    if (opts.listError) throw opts.listError;
    return records;
  }),
  get: vi.fn(async (id: string) => records.find((r) => r.id === id)),
});

const cr = (id: string, over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id,
  spec: { owner: "alice", sandboxRef: `conv-${id}` },
  phase: "Assigned",
  hostPod: SELF,
  generation: 1,
  ...over,
});

/** A provisioner reporting `names` as still-running Sandboxes in the cluster. */
const provisionerWithLive = (names: string[]) => {
  const p = fakeProvisioner();
  p.reconcile = vi.fn(async () => names.map((n) => ({ ref: { name: n, namespace: "ns" }, running: true })));
  return p;
};

describe("hydrate() adopts from the conversation registry", () => {
  it("THE REGRESSION: an EMPTY local store still adopts a row whose Sandbox is running", async () => {
    // The pod restarts with local state wiped while the row and the Sandbox both survive.
    const prov = provisionerWithLive(["conv-gamma"]);
    const registry = registryWith([cr("gamma")]);
    const sessions = createSessionManager({
      provisioner: prov,
      store: inMemoryStore(),
      conversationRegistry: registry as never,
      selfPod: SELF,
    } as never);

    await sessions.hydrate();

    expect(sessions.list(), "the row is the source of truth; local was empty").toHaveLength(1);
    expect(sessions.get("gamma")?.status).toBe("running");

    // The sweep can therefore reclaim it.
    const swept = await sessions.sweepIdle(0);
    expect(swept).toContain("gamma");
    expect(prov.suspend).toHaveBeenCalledOnce();
  });

  it("does NOT adopt a conversation assigned to ANOTHER pod (I6: one owner)", async () => {
    const prov = provisionerWithLive(["conv-other"]);
    const registry = registryWith([cr("other", { hostPod: "agent-host-somebody-else" })]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    expect(sessions.list()).toHaveLength(0);
    // It must not be swept out from under its real owner.
    expect(await sessions.sweepIdle(0)).toEqual([]);
    expect(prov.suspend).not.toHaveBeenCalled();
  });

  it("does NOT adopt an UNASSIGNED row — the controller is the single assigner (decision Q1)", async () => {
    // hostPod unset means the controller has not placed it yet, and self-assigning would race its load accounting.
    const prov = provisionerWithLive(["conv-pending"]);
    const registry = registryWith([cr("pending", { hostPod: undefined, phase: undefined })]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    expect(sessions.list()).toHaveLength(0);
  });

  it("adopts a row with NO local meta and NO history — enough to SUSPEND it (I5)", async () => {
    // suspend() throws for anything not in `entries`, so the adopted row needs a synthesized entry.
    const prov = provisionerWithLive(["conv-bare"]);
    const registry = registryWith([cr("bare")]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    await expect(sessions.suspend("bare")).resolves.not.toThrow();
    expect(prov.suspend).toHaveBeenCalledOnce();
  });

  it("a row whose Sandbox is NOT running hydrates as suspended (not a phantom live pod)", async () => {
    const prov = provisionerWithLive([]);
    const registry = registryWith([cr("sleepy", { phase: "Suspended" })]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    expect(sessions.get("sleepy")?.status).toBe("suspended");
    // sweepIdle only suspends running conversations.
    expect(await sessions.sweepIdle(0)).toEqual([]);
    expect(prov.suspend).not.toHaveBeenCalled();
  });

  it("carries the row's spec onto the adopted entry (owner survives the restart)", async () => {
    const prov = provisionerWithLive(["conv-owned"]);
    const registry = registryWith([cr("owned", { spec: { owner: "bob", sandboxRef: "conv-owned", model: "m1" } })]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    const c = sessions.get("owned");
    expect(c?.owner).toBe("bob");
    expect(c?.model).toBe("m1");
  });

  it("a LOCAL meta with no assignment still hydrates, and hydrate does not re-register it", async () => {
    // Re-registering at boot would only stamp this pod as creator_pod on every conversation.
    const root = inMemoryStore();
    const prov1 = fakeProvisioner();
    const reg1 = registryWith([]);
    const m1 = createSessionManager({
      provisioner: prov1, store: root, conversationRegistry: reg1 as never, selfPod: SELF,
    } as never);
    await m1.start("orphan-local");

    // Same store, still no row for it.
    const reg2 = registryWith([]);
    const m2 = createSessionManager({
      provisioner: provisionerWithLive([]), store: root,
      conversationRegistry: reg2 as never, selfPod: SELF,
    } as never);
    await m2.hydrate();
    expect(m2.list().map((c) => c.id)).toContain("orphan-local");
    expect(reg2.register, "boot must not rewrite every row's creator_pod").not.toHaveBeenCalled();
  });

  it("PROPAGATES a row list failure — a pod that cannot read the truth must not serve (Q4)", async () => {
    // Returning [] would be indistinguishable from owning nothing, so the pod would serve blind.
    const registry = registryWith([], { listError: new Error("apiserver unavailable") });
    const sessions = createSessionManager({
      provisioner: provisionerWithLive([]), store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await expect(sessions.hydrate()).rejects.toThrow(/apiserver|list/i);
  });

  it("single-replica (noop registry, no selfPod) still hydrates from the local store", async () => {
    // No rows exist in single-replica, so the local store must remain the path there.
    const root = inMemoryStore();
    const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: root });
    await m1.start("solo");

    const m2 = createSessionManager({ provisioner: provisionerWithLive([]), store: root });
    await m2.hydrate();
    expect(m2.list().map((c) => c.id)).toContain("solo");
  });
});

describe("refreshSandbox() un-freezes a hydrated snapshot", () => {
  it("a placeholder hydrated while the Sandbox was mid-create picks up the real ref once it exists", async () => {
    // Read-path hydration (the UI's first poll) can land before provisioning finishes, freezing a
    // namespace-less placeholder and "suspended" on a pod that is about to run.
    const live: string[] = [];
    const prov = fakeProvisioner();
    prov.reconcile = vi.fn(async () => live.map((n) => ({ ref: { name: n, namespace: "ns" }, running: true })));
    const sessions = createSessionManager({
      provisioner: prov,
      store: inMemoryStore(),
      conversationRegistry: registryWith([cr("delta")]) as never,
      selfPod: SELF,
    } as never);
    expect(await sessions.ensureReadable("delta" as SessionId)).toBe(true);
    const before = sessions.get("delta" as SessionId)!;
    expect(before.status).toBe("suspended");
    expect(before.sandbox.namespace).toBe("");

    live.push(before.sandbox.name);
    await sessions.refreshSandbox!("delta" as SessionId);
    const after = sessions.get("delta" as SessionId)!;
    expect(after.status).toBe("running");
    expect(after.sandbox).toEqual({ name: before.sandbox.name, namespace: "ns" });
  });

  it("is throttled, and leaves the placeholder alone while the Sandbox is still absent", async () => {
    const prov = provisionerWithLive([]);
    const sessions = createSessionManager({
      provisioner: prov,
      store: inMemoryStore(),
      conversationRegistry: registryWith([cr("eps")]) as never,
      selfPod: SELF,
    } as never);
    await sessions.ensureReadable("eps" as SessionId);
    const calls = (prov.reconcile as ReturnType<typeof vi.fn>).mock.calls.length;
    await sessions.refreshSandbox!("eps" as SessionId);
    await sessions.refreshSandbox!("eps" as SessionId);
    expect((prov.reconcile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 1);
    expect(sessions.get("eps" as SessionId)!.sandbox.namespace).toBe("");
  });
});

describe("on-demand hydration under concurrent first requests", () => {
  it("a later hydrate does not replace the entry a prompt already revived (a Stop must find the live bridge)", async () => {
    // A conversation's first requests after it lands on this pod (prompt, history, stream) hydrate
    // concurrently. The second hydrate's reconcile resolves only after the prompt's run is live; it
    // used to overwrite the revived entry with a bridgeless "suspended" one, so Stop found no bridge.
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((r) => (releaseSecond = r));
    let reconciles = 0;
    const prov = fakeProvisioner();
    prov.reconcile = vi.fn(async () => {
      if (++reconciles === 2) await secondGate;
      return [];
    });
    const bridgePrompt = vi.fn(async () => "run-x");
    const bridgeFactory = () =>
      ({
        start: vi.fn(async () => {}),
        prompt: bridgePrompt,
        stop: vi.fn(async () => {}),
        cancel: vi.fn(async () => {}),
        onEvent: () => () => {},
        onPersist: () => () => {},
        onTitle: () => () => {},
      }) as never;
    const store = inMemoryStore();
    await store.saveMeta!({ id: "delta", threadId: "delta", title: "", createdAt: 0, lastActivityAt: 0 } as never);
    const sessions = createSessionManager({
      provisioner: prov,
      store,
      bridgeFactory,
      conversationRegistry: registryWith([cr("delta")]) as never,
      selfPod: SELF,
    } as never);

    const prompted = sessions.promptByThread("delta" as never, "!sleep 20");
    const readable = sessions.ensureReadable("delta" as never);
    await vi.waitFor(() => expect(bridgePrompt).toHaveBeenCalledOnce());
    releaseSecond();
    expect(await readable).toBe(true);
    await prompted;

    expect(sessions.get("delta")?.bridge, "the entry Stop reads still holds the live bridge").toBeDefined();
    expect(sessions.get("delta")?.status).toBe("running");
  });
});

describe("boot after an OOM storm (2026-10-19)", () => {
  const sb = (id: string) => `conv-${shortId(id)}`;

  it("THE BUG: an adopted subagent maps to its root's sandbox, even listed before the root and with a stale sandboxRef @proves", async () => {
    // The storm left each subagent with its own running Sandbox and sandbox_ref.
    const prov = provisionerWithLive([sb("root"), sb("kid")]);
    const registry = registryWith([
      cr("kid", { spec: { owner: "alice", parentId: "root", sandboxRef: sb("kid") } }),
      cr("root", { spec: { owner: "alice", sandboxRef: sb("root") } }),
    ]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    expect(sessions.get("kid")?.sandbox.name).toBe(sb("root"));
    expect(sessions.get("kid")?.sandbox).toEqual(sessions.get("root")?.sandbox);
  });

  /** A store whose `id` log ends mid-run. */
  const storeWithDangling = (ids: string[]) => {
    const store = inMemoryStore();
    for (const id of ids) {
      void store.appendEvent(id as SessionId, { type: "RUN_STARTED", threadId: id, runId: `run-${id}` } as AguiEvent);
    }
    return store;
  };
  const eventsOf = async (store: ConversationStore, id: string) => {
    const out: AguiEvent[] = [];
    for await (const e of store.readEvents(id as SessionId)) out.push(e);
    return out;
  };

  it("THE BUG: resumeInterrupted closes a SUSPENDED conversation's dangling run instead of reviving it @proves", async () => {
    const store = storeWithDangling(["asleep", "awake"]);
    const registry = registryWith([cr("asleep", { phase: "Suspended" }), cr("awake")]);
    const sessions = createSessionManager({
      provisioner: provisionerWithLive([sb("awake")]), store,
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);
    await sessions.hydrate();
    const prompt = vi.spyOn(sessions, "prompt").mockResolvedValue(undefined as never);

    const resumed = await sessions.resumeInterrupted();

    expect(resumed).toEqual(["awake"]);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toBe("awake");
    const tail = (await eventsOf(store, "asleep")).at(-1) as { type: string; runId: string; cancelled?: boolean };
    expect(tail).toMatchObject({ type: "RUN_FINISHED", runId: "run-asleep", cancelled: true });
  });

  it("a second boot finds nothing dangling on the suspended conversation", async () => {
    const store = storeWithDangling(["asleep"]);
    const registry = registryWith([cr("asleep", { phase: "Suspended" })]);
    const boot = async () => {
      const s = createSessionManager({
        provisioner: provisionerWithLive([]), store,
        conversationRegistry: registry as never, selfPod: SELF,
      } as never);
      await s.hydrate();
      return s;
    };
    await (await boot()).resumeInterrupted();
    const before = (await eventsOf(store, "asleep")).length;
    await (await boot()).resumeInterrupted();
    expect((await eventsOf(store, "asleep")).length).toBe(before);
  });
});

describe("on-demand hydration reads only its own rows", () => {
  /** A store and provisioner whose full-list reads are spies, with single-row reads beside them. */
  const singleRowWorld = (metas: Array<Record<string, unknown>>, sandboxes: Record<string, boolean>) => {
    const store = {
      ...inMemoryStore(),
      listConversations: vi.fn(async () => metas),
      readMeta: vi.fn(async (id: string) => metas.find((m) => m.id === id)),
      listBySandboxRef: vi.fn(async (name: string) => metas.filter((m) => !m.parentId && m.sandboxRef === name)),
      listUnrecorded: vi.fn(async () => metas.filter((m) => !m.parentId && !m.sandboxRef)),
    } as unknown as ConversationStore;
    const prov = fakeProvisioner();
    prov.reconcile = vi.fn(async () => []);
    prov.readSandbox = vi.fn(async (name: string) =>
      name in sandboxes ? { ref: { name, namespace: "ns" }, running: sandboxes[name] } : undefined,
    );
    const sessions = createSessionManager({
      provisioner: prov,
      store,
      conversationRegistry: registryWith([]) as never,
      selfPod: SELF,
    } as never);
    return { store, prov, sessions };
  };
  const meta = (id: string, over: Record<string, unknown> = {}) => ({
    id, threadId: id, title: "", createdAt: 0, lastActivityAt: 0, ...over,
  });

  it("a subagent hydrates from its chain's rows and its root's Sandbox, with no full list", async () => {
    const { store, prov, sessions } = singleRowWorld(
      [meta("root", { sandboxRef: "conv-root" }), meta("mid", { parentId: "root" }), meta("leaf", { parentId: "mid" })],
      { "conv-root": true },
    );
    expect(await sessions.ensureReadable("leaf" as SessionId)).toBe(true);
    const leaf = sessions.get("leaf" as SessionId)!;
    expect(leaf.sandbox).toEqual({ name: "conv-root", namespace: "ns" });
    expect(leaf.status).toBe("running");
    expect(store.listConversations).not.toHaveBeenCalled();
    expect(prov.reconcile).not.toHaveBeenCalled();
    expect(prov.readSandbox).toHaveBeenCalledWith("conv-root");
  });

  it("an unrecorded conversation keeps its full name only when that Sandbox exists", async () => {
    const { prov, sessions } = singleRowWorld([meta("alpha"), meta("beta")], { "conv-alpha": false });
    await sessions.ensureReadable("alpha" as SessionId);
    await sessions.ensureReadable("beta" as SessionId);
    expect(sessions.get("alpha" as SessionId)!.sandbox).toEqual({ name: "conv-alpha", namespace: "ns" });
    expect(sessions.get("beta" as SessionId)!.sandbox).toEqual({ name: `conv-${shortId("beta")}`, namespace: "" });
    expect(prov.reconcile).not.toHaveBeenCalled();
  });

  it("getBySandboxKey finds a recorded or legacy-named conversation with no full list", async () => {
    const legacyId = "0f1e2d3c-aaaa-bbbb-cccc-000000000001";
    const { store, sessions } = singleRowWorld(
      [meta("gamma", { sandboxRef: "conv-gamma" }), meta(legacyId)],
      { "conv-gamma": true, [`conv-${shortId(legacyId)}`]: false },
    );
    expect((await sessions.getBySandboxKey("gamma"))?.id).toBe("gamma");
    expect((await sessions.getBySandboxKey(shortId(legacyId)))?.id).toBe(legacyId);
    expect(store.listConversations).not.toHaveBeenCalled();
  });
});
