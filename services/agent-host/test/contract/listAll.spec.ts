/**
 * Tier 1 contract — SessionManager.listAll(): the DURABLE, fleet-consistent conversation list
 * behind GET /conversations and the /conversations/events snapshot.
 *
 * THE BUG THIS GUARDS. list() reads this pod's in-memory `entries`. On a multi-replica deployment
 * the router fans GET /conversations out to EVERY pod and merges (services/conversation-router/
 * aggregate.go), de-duping by arbitrary arrival order. When two pods hold the same conversation
 * with divergent in-memory state — the owner got the star PATCH + persisted it; a non-owner still
 * holds a stale copy and never re-reads Postgres — successive polls flip between the two rows and
 * the star visibly flaps. listAll() answers from the DURABLE stores instead (Postgres meta + the
 * Conversation CR), so every pod returns byte-identical rows and there is nothing to flap.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createSessionManager,
  type SandboxProvisioner,
  type ConversationStore,
  type ConversationMeta,
} from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";
import type { ConversationRecord } from "../../src/session/conversationRegistry.js";

const SELF = "agent-host-abc";

const fakeProvisioner = (): SandboxProvisioner => ({
  create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" }) as SandboxRef),
  suspend: vi.fn(async () => {}),
  resume: vi.fn(async (ref) => ref),
  destroy: vi.fn(async () => {}),
});

/** In-memory store seeded with durable metas — the Postgres stand-in listAll() reads. */
const storeWithMetas = (seed: ConversationMeta[]): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  const metas = new Map<string, ConversationMeta>(seed.map((m) => [m.id, m]));
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
    saveMeta: async (m: ConversationMeta) => {
      metas.set(m.id, m);
    },
    listConversations: async () => [...metas.values()],
  } as ConversationStore;
};

/** A registry serving `records` as the CR list (the existence + liveness source of truth). */
const registryWith = (records: ConversationRecord[], opts: { listError?: Error } = {}) => ({
  register: vi.fn(async () => {}),
  setPhase: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  list: vi.fn(async () => {
    if (opts.listError) throw opts.listError;
    return records;
  }),
  get: vi.fn(async (id: string) => records.find((r) => r.id === id)),
});

const meta = (id: string, over: Partial<ConversationMeta> = {}): ConversationMeta => ({
  id: id as SessionId,
  threadId: id,
  title: `title-${id}`,
  createdAt: 1000,
  lastActivityAt: 1000,
  ...over,
});

const cr = (id: string, over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id,
  spec: { sandboxRef: `conv-${id}` },
  phase: "Assigned",
  hostPod: SELF,
  generation: 1,
  ...over,
});

const managerFor = (store: ConversationStore, registry: unknown, multiReplica = true) =>
  createSessionManager({
    provisioner: fakeProvisioner(),
    store,
    conversationRegistry: registry as never,
    ...(multiReplica ? { selfPod: SELF } : {}),
  } as never);

describe("SessionManager.listAll()", () => {
  it("THE FLAP FIX: `starred` comes from the durable store, NOT this pod's in-memory entries", async () => {
    // The conversation is starred in Postgres but was never hydrated into THIS pod's memory
    // (or was hydrated stale). list() would miss it / show the stale value; listAll() must
    // report the durable truth so every fleet pod agrees.
    const store = storeWithMetas([meta("alpha", { starred: true })]);
    const sessions = managerFor(store, registryWith([cr("alpha")]));

    expect(sessions.list(), "not in memory on this pod").toHaveLength(0);
    const all = await sessions.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("alpha");
    expect(all[0].starred).toBe(true);
    expect(all[0].title).toBe("title-alpha");
  });

  it("existence follows the CR: a durable-store row with no CR is a deleted ghost, omitted", async () => {
    const store = storeWithMetas([meta("live", { starred: true }), meta("ghost")]);
    const sessions = managerFor(store, registryWith([cr("live")])); // no CR for "ghost"

    const ids = (await sessions.listAll()).map((c) => c.id);
    expect(ids).toEqual(["live"]);
  });

  it("maps CR phase to status uniformly (Suspended -> suspended, Assigned -> running)", async () => {
    const store = storeWithMetas([meta("a", { createdAt: 2 }), meta("b", { createdAt: 1 })]);
    const sessions = managerFor(store, registryWith([cr("a", { phase: "Assigned" }), cr("b", { phase: "Suspended" })]));

    const all = await sessions.listAll();
    expect(all.map((c) => [c.id, c.status])).toEqual([
      ["a", "running"],
      ["b", "suspended"],
    ]);
  });

  it("newest first, by createdAt", async () => {
    const store = storeWithMetas([meta("old", { createdAt: 10 }), meta("new", { createdAt: 99 })]);
    const sessions = managerFor(store, registryWith([cr("old"), cr("new")]));

    expect((await sessions.listAll()).map((c) => c.id)).toEqual(["new", "old"]);
  });

  it("degrades to the in-memory list when the CR read fails (never blanks the sidebar)", async () => {
    const store = storeWithMetas([meta("alpha", { starred: true })]);
    const sessions = managerFor(store, registryWith([cr("alpha")], { listError: new Error("apiserver down") }));

    // Falls back to list() (empty here — nothing hydrated), rather than throwing/blanking.
    await expect(sessions.listAll()).resolves.toEqual(sessions.list());
  });

  it("single-replica (no CR registry): listAll() is the in-memory list()", async () => {
    // No selfPod => noopRegistry, no fan-out, in-memory map is the source of truth.
    const store = storeWithMetas([]);
    const sessions = managerFor(store, undefined, /* multiReplica */ false);
    await sessions.start("solo" as SessionId);

    const all = await sessions.listAll();
    expect(all.map((c) => c.id)).toEqual(sessions.list().map((c) => c.id));
    expect(all.map((c) => c.id)).toContain("solo");
  });
});
