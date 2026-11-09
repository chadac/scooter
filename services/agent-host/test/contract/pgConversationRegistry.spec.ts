/**
 * The conversation registry on the conversations row: writes are UPDATE/DELETE of the row the
 * router inserted and never propagate a failure, an absent spec field is omitted rather than
 * nulled, and reads (list/get) come from the row and throw on failure so hydrate never serves
 * a blind view.
 */

import { describe, it, expect } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { createPgConversationRegistry } from "../../src/session/pgConversationRegistry.js";
import { noopRegistry } from "../../src/session/conversationRegistry.js";

/** A fake db capturing the statements issued and answering selects with `rows`. */
function fakeDb(opts: { fail?: boolean; rows?: unknown[][] } = {}): {
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
      // drizzle selects in array row mode.
      return { rows: opts.rows ?? [], rowCount: 1 };
    },
  };
  return { db: drizzle(client as never), stmts };
}

// Column order of the registry's select: id, model, owner, parent_id, kind, sandbox_ref, creator_pod,
// phase, host_pod, host_generation.
const row = (over: Partial<Record<string, unknown>> = {}): unknown[] => {
  const r = {
    id: "conv-a", model: "m", owner: "alice", parentId: null, kind: null, sandboxRef: "conv-xyz",
    creatorPod: "pod-0", phase: "Assigned", hostPod: "pod-1", hostGeneration: "3", ...over,
  };
  return [r.id, r.model, r.owner, r.parentId, r.kind, r.sandboxRef, r.creatorPod, r.phase, r.hostPod, r.hostGeneration];
};

describe("the row-backed conversation registry: writes", () => {
  it("register writes sandbox_ref and creator_pod to the row", async () => {
    const { db, stmts } = fakeDb();
    await createPgConversationRegistry({ db }).register("conv-1", {
      sandboxRef: "conv-abc", creatorPod: "agent-host-0", model: "m", owner: "alice",
    });
    expect(stmts).toHaveLength(1);
    expect(stmts[0].text).toMatch(/^update "conversations" set/i);
    expect(stmts[0].values).toEqual(expect.arrayContaining(["conv-abc", "agent-host-0", "conv-1"]));
  });

  it("does NOT write model/owner/parentId — the router's insert and saveMeta own those columns", async () => {
    const { db, stmts } = fakeDb();
    await createPgConversationRegistry({ db }).register("conv-1", {
      sandboxRef: "conv-abc", model: "claude-opus-4", owner: "alice", parentId: "conv-0",
    });
    expect(stmts[0].text).not.toMatch(/"model"/);
    expect(stmts[0].text).not.toMatch(/"owner"/);
    expect(stmts[0].text).not.toMatch(/"parent_id"/);
  });

  it("OMITS an absent sandboxRef instead of nulling it — a re-register must not erase the routing ref", async () => {
    const { db, stmts } = fakeDb();
    await createPgConversationRegistry({ db }).register("conv-1", { creatorPod: "agent-host-0" });
    expect(stmts[0].text).not.toMatch(/"sandbox_ref"/);
    expect(stmts[0].values).not.toContain(null);
  });

  it("issues NO statement when a register carries neither field", async () => {
    const { db, stmts } = fakeDb();
    await createPgConversationRegistry({ db }).register("conv-1", { model: "m" });
    expect(stmts).toHaveLength(0);
  });

  it("never inserts: the router owns creating the row", async () => {
    const { db, stmts } = fakeDb();
    const reg = createPgConversationRegistry({ db });
    await reg.register("conv-1", { sandboxRef: "conv-abc" });
    await reg.setPhase("conv-1", "Suspended");
    expect(stmts.some((s) => /^insert/i.test(s.text))).toBe(false);
  });

  it("setPhase writes the phase column", async () => {
    const { db, stmts } = fakeDb();
    await createPgConversationRegistry({ db }).setPhase("conv-1", "Suspended");
    expect(stmts[0].text).toMatch(/^update "conversations" set "phase"/i);
    expect(stmts[0].values).toEqual(expect.arrayContaining(["Suspended", "conv-1"]));
  });

  it("remove deletes the row", async () => {
    const { db, stmts } = fakeDb();
    await createPgConversationRegistry({ db }).remove("conv-1");
    expect(stmts[0].text).toMatch(/^delete from "conversations"/i);
  });

  it("A WRITE FAILURE NEVER PROPAGATES — a Postgres blip must not stop a conversation starting", async () => {
    const reg = createPgConversationRegistry({ db: fakeDb({ fail: true }).db });
    await expect(reg.register("conv-1", { sandboxRef: "conv-abc" })).resolves.toBeUndefined();
    await expect(reg.setPhase("conv-1", "Assigned")).resolves.toBeUndefined();
    await expect(reg.remove("conv-1")).resolves.toBeUndefined();
  });
});

describe("the row-backed conversation registry: reads", () => {
  it("list folds each row into a record with the placement", async () => {
    const { db } = fakeDb({ rows: [row()] });
    expect(await createPgConversationRegistry({ db }).list()).toEqual([
      {
        id: "conv-a",
        spec: { model: "m", owner: "alice", sandboxRef: "conv-xyz", creatorPod: "pod-0" },
        phase: "Assigned",
        hostPod: "pod-1",
        generation: 3,
      },
    ]);
  });

  it("an unplaced row has no hostPod, and a phase agent-host does not act on is dropped", async () => {
    const { db } = fakeDb({ rows: [row({ hostPod: null, phase: "Pending", hostGeneration: "0", parentId: "conv-p" })] });
    const [rec] = await createPgConversationRegistry({ db }).list();
    expect(rec.hostPod).toBeUndefined();
    expect(rec.phase).toBeUndefined();
    expect(rec.spec.parentId).toBe("conv-p");
    expect(rec.generation).toBe(0);
  });

  it("get returns the one row, or undefined when there is none", async () => {
    expect((await createPgConversationRegistry({ db: fakeDb({ rows: [row()] }).db }).get("conv-a"))?.hostPod).toBe("pod-1");
    await expect(createPgConversationRegistry({ db: fakeDb().db }).get("nope")).resolves.toBeUndefined();
  });

  it("READS THROW on failure — an empty list would make hydrate serve blind", async () => {
    const reg = createPgConversationRegistry({ db: fakeDb({ fail: true }).db });
    await expect(reg.list()).rejects.toThrow(/Failed query/);
    await expect(reg.get("conv-a")).rejects.toThrow(/Failed query/);
  });
});

describe("noopRegistry (single-replica)", () => {
  it("every write is a no-op that resolves", async () => {
    await expect(noopRegistry.register("c", { sandboxRef: "conv-c" })).resolves.toBeUndefined();
    await expect(noopRegistry.setPhase("c", "Suspended")).resolves.toBeUndefined();
    await expect(noopRegistry.remove("c")).resolves.toBeUndefined();
  });

  it("list() is [] and get() is undefined", async () => {
    await expect(noopRegistry.list()).resolves.toEqual([]);
    await expect(noopRegistry.get("anything")).resolves.toBeUndefined();
  });
});
