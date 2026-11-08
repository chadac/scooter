/**
 * Conversation metadata lives in Postgres so the sidebar survives a rollout. Every test
 * runs with an empty file store and the data only in the database. pendingQueue
 * (messages queued at suspend, re-enqueued by revive()) and parentId (the subagent
 * hierarchy) must round-trip exactly.
 */

import { describe, it, expect, vi } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { createPgMetaStore } from "../../src/session/metaStore.js";
import type { ConversationMeta } from "../../src/session/manager.js";
import type { SessionId, ThreadId } from "../../src/types.js";

const meta = (over: Partial<ConversationMeta> = {}): ConversationMeta =>
  ({
    id: "conv-1" as SessionId,
    threadId: "thread-1" as ThreadId,
    title: "A conversation",
    createdAt: 1_000,
    lastActivityAt: 2_000,
    ...over,
  }) as ConversationMeta;

/** A tiny in-memory stand-in for the pg Pool covering the statements this store issues and honouring the id primary key and both conflict actions, where `created(id)` stands in for the row the creator wrote. */
function fakeDb(): {
  db: NodePgDatabase;
  rows: Map<string, Record<string, unknown>>;
  created: (id: string) => void;
} {
  const rows = new Map<string, Record<string, unknown>>();

  // Column order matches lib/sql/agent_host/schema.sql because drizzle's bare .select() maps positionally.
  const ORDER = [
    "id", "thread_id", "title", "created_at", "last_activity_at",
    "model", "model_set_by", "owner", "parent_id", "user_titled", "starred", "pending_queue",
  ] as const;

  const client = {
    async query(cfg: { text: string; values?: unknown[] } | string, params: unknown[] = []) {
      const text = typeof cfg === "string" ? cfg : cfg.text;
      const values = (typeof cfg === "string" ? params : (cfg.values ?? params)) as unknown[];
      const head = text.trim().toUpperCase();

      if (head.startsWith("INSERT")) {
        const [id, threadId, title, createdAt, lastActivityAt, model, modelSetBy, owner, parentId, userTitled, starred, pendingQueue] =
          values as [string, string, string, number, number, string | null, string | null, string | null, string | null, boolean | null, boolean | null, unknown];
        if (rows.has(id) && !/DO UPDATE/i.test(text)) return { rows: [], rowCount: 0 };
        rows.set(id, {
          id,
          thread_id: threadId,
          title,
          // node-postgres returns bigint columns as strings.
          created_at: String(createdAt),
          last_activity_at: String(lastActivityAt),
          model,
          model_set_by: modelSetBy,
          owner,
          parent_id: parentId,
          user_titled: userTitled,
          starred,
          pending_queue: pendingQueue,
        });
        return { rows: [], rowCount: 1 };
      }

      if (head.startsWith("UPDATE")) {
        // Applies SET assignments by column name.
        const param = (ref: string) => values[Number(ref.slice(1)) - 1];
        const target = param(/where .*"id" = (\$\d+)/i.exec(text)![1]) as string;
        const row = rows.get(target);
        if (!row) return { rows: [], rowCount: 0 }; // no row => nothing written
        const setClause = text.slice(text.search(/ set /i) + 5, text.search(/ where /i));
        const next = { ...row };
        for (const [, col, expr] of setClause.matchAll(/"(\w+)" = (CASE WHEN .*? END|GREATEST\(.*?\)|\$\d+)/gi)) {
          const ref = /\$\d+/.exec(expr)![0];
          const v = param(ref);
          if (expr.startsWith("GREATEST")) next[col] = String(Math.max(Number(row[col]), Number(v)));
          else if (expr.startsWith("CASE")) next[col] = row.user_titled === true ? row[col] : v;
          else next[col] = col === "created_at" || col === "last_activity_at" ? String(v) : v;
        }
        rows.set(target, next);
        return { rows: [], rowCount: 1 };
      }

      if (head.startsWith("SELECT") && /WHERE/i.test(text)) {
        // A narrow read by id: the selected columns, in order.
        const row = rows.get(values[0] as string);
        const cols = [...text.slice(0, text.search(/ from /i)).matchAll(/"(\w+)"(?:,|$)/g)].map((m) => m[1]);
        return { rows: row ? [cols.map((c) => row[c])] : [], rowCount: row ? 1 : 0 };
      }

      if (head.startsWith("SELECT")) {
        const out = [...rows.values()]
          .sort((a, b) => Number(b.last_activity_at) - Number(a.last_activity_at))
          .map((r) => ORDER.map((c) => r[c]));
        return { rows: out, rowCount: out.length };
      }

      if (head.startsWith("DELETE")) {
        const [id] = values as [string];
        const had = rows.delete(id);
        return { rows: [], rowCount: had ? 1 : 0 };
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };
  /** The create-time row: identity columns, no metadata yet. */
  const created = (id: string) => {
    rows.set(id, {
      id,
      thread_id: id,
      title: "",
      created_at: "0",
      last_activity_at: "0",
      model: null,
      model_set_by: null,
      owner: null,
      parent_id: null,
      user_titled: null,
      starred: null,
      pending_queue: null,
    });
  };

  return { db: drizzle(client as never), rows, created };
}

/** Stands in for the conversation-router's targeted UPDATE. */
const routerWrites = (rows: Map<string, Record<string, unknown>>, id: string, cols: Record<string, unknown>) =>
  Object.assign(rows.get(id)!, cols);

/** A file-backed store standing in for one a deployment still carries on disk. */
const legacyWith = (metas: ConversationMeta[]) => ({
  listConversations: vi.fn(async () => metas),
});

describe("conversation metadata in Postgres", () => {
  it("THE ROLLOUT SHAPE: conversations list when the file store is wiped", async () => {
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db, legacy: legacyWith([]) });
    created("conv-1");
    created("conv-2");

    await store.saveMeta(meta({ id: "conv-1" as SessionId }));
    await store.saveMeta(meta({ id: "conv-2" as SessionId }));

    expect((await store.listConversations()).map((m) => m.id).sort()).toEqual(["conv-1", "conv-2"]);
  });

  // An upsert would resurrect a row removed at teardown.
  it("saveMeta writes NOTHING when the conversation has no row", async () => {
    const { db, rows } = fakeDb();
    const store = createPgMetaStore({ db });

    await store.saveMeta(meta({ id: "never-created" as SessionId }));

    expect(rows.size).toBe(0);
    expect(await store.listConversations()).toEqual([]);
  });

  it("saveMeta does not RESURRECT a removed conversation", async () => {
    const { db, created, rows } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    await store.saveMeta(meta());
    await store.removeConversation("conv-1" as SessionId);

    await store.saveMeta(meta({ title: "a straggler from an in-flight run" }));

    expect(rows.size).toBe(0);
  });

  it("round-trips every field", async () => {
    const { db, rows, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    const full = meta({
      model: "claude-opus-4",
      modelSetBy: "agent",
      owner: "user@example.com",
      parentId: "conv-parent" as SessionId,
      userTitled: true,
      starred: true,
      pendingQueue: [{ text: "the queued message", priority: 1 }],
    });

    await store.saveMeta(full);
    routerWrites(rows, "conv-1", { starred: true, user_titled: true });
    expect((await store.listConversations())[0]).toEqual(full);
  });

  it("PRESERVES pendingQueue — a user's undelivered message is not lost", async () => {
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    await store.saveMeta(
      meta({ pendingQueue: [{ text: "first", priority: 0 }, { text: "second", priority: 1 }] }),
    );

    expect((await store.listConversations())[0].pendingQueue).toEqual([
      { text: "first", priority: 0 },
      { text: "second", priority: 1 },
    ]);
  });

  it("persists a CLEARED queue as empty, not absent", async () => {
    // revive() clears the queue after re-enqueuing, and collapsing [] to NULL would make the next hydrate re-deliver messages the user already received.
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    await store.saveMeta(meta({ pendingQueue: [{ text: "queued", priority: 0 }] }));
    await store.saveMeta(meta({ pendingQueue: [] }));

    expect((await store.listConversations())[0].pendingQueue).toEqual([]);
  });

  it("parses a pendingQueue delivered as raw jsonb text", async () => {
    const { db, rows, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    await store.saveMeta(meta({ pendingQueue: [{ text: "q", priority: 0 }] }));
    rows.get("conv-1")!.pending_queue = JSON.stringify([{ text: "q", priority: 0 }]);

    expect((await store.listConversations())[0].pendingQueue).toEqual([{ text: "q", priority: 0 }]);
  });

  it("PRESERVES parentId — the subagent hierarchy survives", async () => {
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("sub-1");
    await store.saveMeta(meta({ id: "sub-1" as SessionId, parentId: "conv-root" as SessionId }));

    expect((await store.listConversations())[0].parentId).toBe("conv-root");
  });

  it("coerces bigint timestamps back to numbers", async () => {
    // The idle sweep and the sidebar sort do arithmetic on these.
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    await store.saveMeta(meta({ createdAt: 1_700_000_000_000, lastActivityAt: 1_700_000_009_999 }));

    const [got] = await store.listConversations();
    expect(got.createdAt).toBe(1_700_000_000_000);
    expect(got.lastActivityAt).toBe(1_700_000_009_999);
  });

  it("omits absent optionals rather than materializing them as null", async () => {
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    await store.saveMeta(meta());

    const [got] = await store.listConversations();
    expect(got).not.toHaveProperty("model");
    expect(got).not.toHaveProperty("owner");
    expect(got).not.toHaveProperty("parentId");
  });

  it("saveMeta UPDATES an existing conversation in place", async () => {
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    await store.saveMeta(meta({ title: "New chat" }));
    await store.saveMeta(meta({ title: "Agent title" }));

    const listed = await store.listConversations();
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("Agent title");
  });

  it("a stale replica's saveMeta does not UNSTAR a conversation the router starred", async () => {
    const { db, rows, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    // The router stars it; this replica's copy still says unstarred.
    routerWrites(rows, "conv-1", { starred: true });
    await store.saveMeta(meta({ starred: false, lastActivityAt: 3_000 }));
    await store.saveMeta(meta({ lastActivityAt: 4_000 }));

    expect((await store.readRouterMeta("conv-1" as SessionId))?.starred).toBe(true);
    expect((await store.listConversations())[0].starred).toBe(true);
    expect(await store.readRouterMeta("missing" as SessionId)).toBeUndefined();
  });

  it("a stale replica's saveMeta does not undo a user rename", async () => {
    const { db, rows, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    routerWrites(rows, "conv-1", { title: "My name", user_titled: true });
    await store.saveMeta(meta({ title: "New chat", userTitled: false }));

    const [row] = await store.listConversations();
    expect(row.title).toBe("My name");
    expect(row.userTitled).toBe(true);
    expect(await store.readRouterMeta("conv-1" as SessionId)).toEqual({
      title: "My name",
      userTitled: true,
      starred: false,
      visibility: "shared",
    });
  });

  it("orders the list by recency", async () => {
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("older");
    created("newer");
    await store.saveMeta(meta({ id: "older" as SessionId, lastActivityAt: 1_000 }));
    await store.saveMeta(meta({ id: "newer" as SessionId, lastActivityAt: 9_000 }));

    expect((await store.listConversations()).map((m) => m.id)).toEqual(["newer", "older"]);
  });

  it("readMeta reads one row by id, undefined when it is absent", async () => {
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    await store.saveMeta(meta({ parentId: "root" as SessionId }));

    expect(await store.readMeta("conv-1" as SessionId)).toMatchObject({
      id: "conv-1",
      title: "A conversation",
      lastActivityAt: 2_000,
      parentId: "root",
    });
    expect(await store.readMeta("missing" as SessionId)).toBeUndefined();
  });

  it("removeConversation keeps it from coming back", async () => {
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");
    await store.saveMeta(meta());
    await store.removeConversation("conv-1" as SessionId);

    expect(await store.listConversations()).toEqual([]);
  });
});

describe("seeding from file-backed metadata", () => {
  it("serves conversations that exist only on disk", async () => {
    const legacy = legacyWith([meta({ id: "on-disk" as SessionId })]);
    const store = createPgMetaStore({ db: fakeDb().db, legacy });

    expect((await store.listConversations()).map((m) => m.id)).toEqual(["on-disk"]);
  });

  it("BACKFILLS them, so the next list is served from the database", async () => {
    const legacy = legacyWith([meta({ id: "on-disk" as SessionId })]);
    const store = createPgMetaStore({ db: fakeDb().db, legacy });

    await store.listConversations();
    legacy.listConversations.mockClear();

    expect((await store.listConversations()).map((m) => m.id)).toEqual(["on-disk"]);
    expect(legacy.listConversations).not.toHaveBeenCalled();
  });

  it("carries pendingQueue and parentId through the backfill", async () => {
    const legacy = legacyWith([
      meta({
        id: "on-disk" as SessionId,
        parentId: "root" as SessionId,
        pendingQueue: [{ text: "not yet delivered", priority: 2 }],
      }),
    ]);
    const store = createPgMetaStore({ db: fakeDb().db, legacy });

    await store.listConversations();
    legacy.listConversations.mockClear();

    const [got] = await store.listConversations();
    expect(got.parentId).toBe("root");
    expect(got.pendingQueue).toEqual([{ text: "not yet delivered", priority: 2 }]);
  });

  it("does not seed once the database has any conversation", async () => {
    const legacy = legacyWith([meta({ id: "on-disk" as SessionId })]);
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db, legacy });
    created("live");

    await store.saveMeta(meta({ id: "live" as SessionId }));
    expect((await store.listConversations()).map((m) => m.id)).toEqual(["live"]);
    expect(legacy.listConversations).not.toHaveBeenCalled();
  });

  // Another replica's delete leaves this pod's file copy behind.
  it("does not RESURRECT deleted conversations when the table later empties", async () => {
    const legacy = legacyWith([]);
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db, legacy });
    created("conv-1");
    await store.saveMeta(meta());
    await store.listConversations();

    legacy.listConversations.mockResolvedValue([meta()]);
    await store.removeConversation("conv-1" as SessionId);

    expect(await store.listConversations()).toEqual([]);
    expect(await store.listConversations()).toEqual([]);
    expect(legacy.listConversations).not.toHaveBeenCalled();
  });

  it("seeds at most once, even when the first list found the file store empty", async () => {
    const legacy = legacyWith([]);
    const store = createPgMetaStore({ db: fakeDb().db, legacy });
    await store.listConversations();

    legacy.listConversations.mockResolvedValue([meta({ id: "stale" as SessionId })]);

    expect(await store.listConversations()).toEqual([]);
    expect(legacy.listConversations).toHaveBeenCalledTimes(1);
  });
});

describe("failure behaviour", () => {
  const brokenDb = (): MetaStoreDb => ({
    query: async () => {
      throw new Error("connection terminated");
    },
    end: async () => {},
  });

  it("listConversations THROWS rather than reporting an empty list", async () => {
    // Answering [] for "could not read them" blanks the sidebar while the data is intact.
    const store = createPgMetaStore({ db: brokenDb() });
    await expect(store.listConversations()).rejects.toThrow();
  });

  it("saveMeta degrades quietly — a metadata write must not fail the turn", async () => {
    const store = createPgMetaStore({ db: brokenDb() });
    await expect(store.saveMeta(meta())).resolves.toBeUndefined();
  });

  it("lastActivityAt only moves forward, from any replica", async () => {
    const { db, created } = fakeDb();
    const store = createPgMetaStore({ db });
    created("conv-1");

    await store.saveMeta(meta({ lastActivityAt: 5_000 }));
    // A replica proxying a web service records newer activity...
    await store.touchActivity("conv-1" as SessionId, 9_000);
    expect(await store.readLastActivity("conv-1" as SessionId)).toBe(9_000);
    // ...which neither an older touch nor a stale replica's full save can erase.
    await store.touchActivity("conv-1" as SessionId, 7_000);
    await store.saveMeta(meta({ lastActivityAt: 6_000, title: "renamed" }));
    expect(await store.readLastActivity("conv-1" as SessionId)).toBe(9_000);
    const [row] = await store.listConversations();
    expect(row.title).toBe("renamed");
    expect(await store.readLastActivity("missing" as SessionId)).toBeUndefined();
  });
});
