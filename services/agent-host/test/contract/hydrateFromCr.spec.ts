/**
 * Tier 1 contract — hydrate() driven by the Conversation CR (the SOURCE OF TRUTH).
 *
 * THE BUG THIS REPLACES. hydrate() looped over the LOCAL store's metas and used the cluster only
 * as a lookup keyed by a local record (`live.get(name)`). LOCAL_STATE_PATH is an emptyDir, so a
 * restarted pod has no metas, the loop body never runs, and `entries` stays empty — which makes
 * sweepIdle() and resumeInterrupted() (both `for (const entry of entries.values())`) no-ops
 * forever. Measured on odin: 21 running Sandboxes, 48 Conversation CRs, 59 conversations in the
 * durable store, and GET /conversations returning 0. 42 requested cores on a 24-core node, every
 * rollout deadlocked. See docs/CONVERSATION_STATE_MODEL.md.
 *
 * WHY THE EXISTING TEST DIDN'T CATCH IT. session.spec.ts:480 encodes exactly this invariant
 * ("hydrate reconciles a still-running Sandbox as running so the idle sweep reclaims it") and
 * PASSES — because it hands the SAME file-store root to both simulated processes. It models a
 * restart with durable state; production restarts with WIPED state. The property was right; the
 * fixture was more durable than the deployment. Every test here therefore states its durability
 * assumption explicitly: the second manager always gets an EMPTY local store.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createSessionManager,
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

/** In-memory store WITH meta persistence, so "the local cache survived" is expressible.
 *  (The plain fixture in session.spec.ts omits listConversations, which would make every
 *  local-path assertion here vacuously pass.) */
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

/** A registry serving `records` as the CR list. */
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

describe("hydrate() adopts from the Conversation CR", () => {
  it("THE REGRESSION: an EMPTY local store still adopts a CR whose Sandbox is running", async () => {
    // The exact production shape: pod restarts (local wiped), the CR and the Sandbox both survive.
    const prov = provisionerWithLive(["conv-gamma"]);
    const registry = registryWith([cr("gamma")]);
    const sessions = createSessionManager({
      provisioner: prov,
      store: inMemoryStore(), // EMPTY — this is the emptyDir
      conversationRegistry: registry as never,
      selfPod: SELF,
    } as never);

    await sessions.hydrate();

    expect(sessions.list(), "the CR is the source of truth; local was empty").toHaveLength(1);
    expect(sessions.get("gamma")?.status).toBe("running");

    // ...and therefore the sweep can finally reclaim it (I2).
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
    // and it must not be swept out from under its real owner
    expect(await sessions.sweepIdle(0)).toEqual([]);
    expect(prov.suspend).not.toHaveBeenCalled();
  });

  it("does NOT adopt an UNASSIGNED CR — the controller is the single assigner (decision Q1)", async () => {
    // hostPod unset = the controller has not placed it yet. Self-assigning would race its load
    // accounting, so we wait rather than claim.
    const prov = provisionerWithLive(["conv-pending"]);
    const registry = registryWith([cr("pending", { hostPod: undefined, phase: undefined })]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    expect(sessions.list()).toHaveLength(0);
  });

  it("adopts a CR with NO local meta and NO history — enough to SUSPEND it (I5)", async () => {
    // suspend() throws for anything not in `entries`, so a leaked sandbox was previously
    // unreachable through the normal API. A synthesized entry closes that.
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

  it("a CR whose Sandbox is NOT running hydrates as suspended (not a phantom live pod)", async () => {
    const prov = provisionerWithLive([]); // nothing running in the cluster
    const registry = registryWith([cr("sleepy", { phase: "Suspended" })]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    expect(sessions.get("sleepy")?.status).toBe("suspended");
    // sweepIdle only suspends RUNNING conversations — nothing to reclaim, no spurious call.
    expect(await sessions.sweepIdle(0)).toEqual([]);
    expect(prov.suspend).not.toHaveBeenCalled();
  });

  it("carries the CR's spec onto the adopted entry (owner survives the restart)", async () => {
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

  it("a LOCAL meta with no CR still hydrates (self-heal, never lose a conversation)", async () => {
    // The cache is not the authority, but it is not garbage either: a conversation created while
    // the CR write failed must keep working and get re-registered.
    const root = inMemoryStore();
    const prov1 = fakeProvisioner();
    const reg1 = registryWith([]);
    const m1 = createSessionManager({
      provisioner: prov1, store: root, conversationRegistry: reg1 as never, selfPod: SELF,
    } as never);
    await m1.start("orphan-local");

    // Same store (so the meta persists), still no CR for it.
    const reg2 = registryWith([]);
    const m2 = createSessionManager({
      provisioner: provisionerWithLive([]), store: root,
      conversationRegistry: reg2 as never, selfPod: SELF,
    } as never);
    await m2.hydrate();
    expect(m2.list().map((c) => c.id)).toContain("orphan-local");
    expect(reg2.register, "the authority self-heals toward completeness").toHaveBeenCalled();
  });

  it("PROPAGATES a CR list failure — a pod that cannot read the truth must not serve (Q4)", async () => {
    // Returning [] here would mean "this pod owns nothing", indistinguishable from the truth, and
    // the pod would serve blind. Boot retries, then fails readiness.
    const registry = registryWith([], { listError: new Error("apiserver unavailable") });
    const sessions = createSessionManager({
      provisioner: provisionerWithLive([]), store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await expect(sessions.hydrate()).rejects.toThrow(/apiserver|list/i);
  });

  it("single-replica (noop registry, no selfPod) still hydrates from the local store", async () => {
    // No CRs exist at all in single-replica; the local store must remain the path there.
    const root = inMemoryStore();
    const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: root });
    await m1.start("solo");

    const m2 = createSessionManager({ provisioner: provisionerWithLive([]), store: root });
    await m2.hydrate();
    expect(m2.list().map((c) => c.id)).toContain("solo");
  });
});
