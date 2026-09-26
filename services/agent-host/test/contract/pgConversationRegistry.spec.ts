/**
 * Tier 1 contract — the registry's writes also land on the conversations ROW, so the row can
 * become the source of truth for existence.
 *
 * The behaviour that matters here is not "it issues an UPDATE"; it is the three rules that make
 * the step additive:
 *   - the CR write keeps its exact semantics (it goes first, and its outcome is untouched)
 *   - a ROW failure never propagates, because a Postgres blip must not stop a conversation
 *     starting — the same reason a k8s blip does not
 *   - an ABSENT spec field is omitted, not nulled, so a re-register without a sandboxRef cannot
 *     erase the ref the router routes by
 *
 * Assignment reads (list/get) must still come from the CR: the controller writes host_pod and it
 * still writes only the CR, so reading the row would answer NULL for every conversation and empty
 * hydrate()'s ownership filter silently.
 */

import { describe, it, expect, vi } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { withConversationRows } from "../../src/session/pgConversationRegistry.js";
import type { ConversationRecord, ConversationRegistry } from "../../src/session/conversationRegistry.js";

/** Captures the statements issued, so the row half can be asserted without a Postgres. */
function fakeDb(opts: { fail?: boolean } = {}): {
  db: NodePgDatabase;
  stmts: { text: string; values: unknown[] }[];
} {
  const stmts: { text: string; values: unknown[] }[] = [];
  const client = {
    async query(cfg: { text: string; values?: unknown[] } | string, params: unknown[] = []) {
      const text = typeof cfg === "string" ? cfg : cfg.text;
      const values = (typeof cfg === "string" ? params : (cfg.values ?? params)) as unknown[];
      stmts.push({ text, values });
      if (opts.fail) throw new Error("pg is down");
      return { rows: [], rowCount: 1 };
    },
  };
  return { db: drizzle(client as never), stmts };
}

/** A CR registry that records calls, standing in for the apiserver half. */
function fakeCr(over: Partial<ConversationRegistry> = {}): ConversationRegistry & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    register: vi.fn(async (id: string) => void calls.push(`register:${id}`)),
    setPhase: vi.fn(async (id: string, phase: string) => void calls.push(`setPhase:${id}:${phase}`)),
    remove: vi.fn(async (id: string) => void calls.push(`remove:${id}`)),
    list: vi.fn(async () => [] as ConversationRecord[]),
    get: vi.fn(async () => undefined),
    ...over,
  } as ConversationRegistry & { calls: string[] };
}

describe("the conversations row half of the registry", () => {
  it("register writes sandbox_ref and creator_pod to the row, and still writes the CR", async () => {
    const cr = fakeCr();
    const { db, stmts } = fakeDb();
    const reg = withConversationRows(cr, { db });

    await reg.register("conv-1", { sandboxRef: "conv-abc", creatorPod: "agent-host-0", model: "m", owner: "alice" });

    expect(cr.calls).toEqual(["register:conv-1"]);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].text).toMatch(/^update "conversations" set/i);
    expect(stmts[0].values).toEqual(expect.arrayContaining(["conv-abc", "agent-host-0", "conv-1"]));
  });

  it("does NOT duplicate model/owner/parentId onto the row — saveMeta already owns those columns", async () => {
    const { db, stmts } = fakeDb();
    const reg = withConversationRows(fakeCr(), { db });

    await reg.register("conv-1", { sandboxRef: "conv-abc", model: "claude-opus-4", owner: "alice", parentId: "conv-0" });

    expect(stmts[0].text).not.toMatch(/"model"/);
    expect(stmts[0].text).not.toMatch(/"owner"/);
    expect(stmts[0].text).not.toMatch(/"parent_id"/);
  });

  it("OMITS an absent sandboxRef instead of nulling it — a re-register must not erase the routing ref", async () => {
    const { db, stmts } = fakeDb();
    const reg = withConversationRows(fakeCr(), { db });

    await reg.register("conv-1", { creatorPod: "agent-host-0" });

    expect(stmts[0].text).not.toMatch(/"sandbox_ref"/);
    expect(stmts[0].values).not.toContain(null);
  });

  it("issues NO statement when a register carries neither field", async () => {
    const cr = fakeCr();
    const { db, stmts } = fakeDb();
    const reg = withConversationRows(cr, { db });

    await reg.register("conv-1", { model: "m" });

    expect(stmts).toHaveLength(0);
    expect(cr.calls).toEqual(["register:conv-1"]); // the CR write still happens
  });

  it("setPhase writes the phase column and the CR", async () => {
    const cr = fakeCr();
    const { db, stmts } = fakeDb();
    const reg = withConversationRows(cr, { db });

    await reg.setPhase("conv-1", "Suspended");

    expect(cr.calls).toEqual(["setPhase:conv-1:Suspended"]);
    expect(stmts[0].text).toMatch(/^update "conversations" set "phase"/i);
    expect(stmts[0].values).toEqual(expect.arrayContaining(["Suspended", "conv-1"]));
  });

  it("remove deletes the row as well as the CR", async () => {
    const cr = fakeCr();
    const { db, stmts } = fakeDb();
    const reg = withConversationRows(cr, { db });

    await reg.remove("conv-1");

    expect(cr.calls).toEqual(["remove:conv-1"]);
    expect(stmts[0].text).toMatch(/^delete from "conversations"/i);
  });

  it("A ROW FAILURE NEVER PROPAGATES — a Postgres blip must not stop a conversation starting", async () => {
    const cr = fakeCr();
    const reg = withConversationRows(cr, { db: fakeDb({ fail: true }).db });

    await expect(reg.register("conv-1", { sandboxRef: "conv-abc" })).resolves.toBeUndefined();
    await expect(reg.setPhase("conv-1", "Assigned")).resolves.toBeUndefined();
    await expect(reg.remove("conv-1")).resolves.toBeUndefined();
    // and the CR half still ran every time
    expect(cr.calls).toEqual(["register:conv-1", "setPhase:conv-1:Assigned", "remove:conv-1"]);
  });

  it("a CR failure still propagates exactly as before — the row half must not swallow it", async () => {
    const boom = new Error("apiserver down");
    const cr = fakeCr({
      list: vi.fn(async () => {
        throw boom;
      }),
    });
    const { db, stmts } = fakeDb();
    const reg = withConversationRows(cr, { db });

    await expect(reg.list()).rejects.toThrow("apiserver down");
    expect(stmts).toHaveLength(0);
  });

  it("ASSIGNMENT READS COME FROM THE CR, not the row — the controller has not moved yet", async () => {
    const record: ConversationRecord = { id: "conv-1", spec: {}, hostPod: "agent-host-2", generation: 7 };
    const cr = fakeCr({ list: vi.fn(async () => [record]), get: vi.fn(async () => record) });
    const { db, stmts } = fakeDb();
    const reg = withConversationRows(cr, { db });

    expect(await reg.list()).toEqual([record]);
    expect((await reg.get("conv-1"))?.hostPod).toBe("agent-host-2");
    // Reading these from the row would answer NULL for every conversation today.
    expect(stmts).toHaveLength(0);
  });
});
