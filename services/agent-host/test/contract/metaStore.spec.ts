/**
 * Tier 1 contract — conversation metadata lives in Postgres, so the sidebar survives a
 * rollout and listing is a query rather than a directory walk.
 *
 * Every test runs in the production shape: the file store is EMPTY (the emptyDir was
 * wiped) and the data is only in the database.
 *
 * Two fields carry more weight than the rest and are pinned hard here:
 *   - pendingQueue — messages the user already sent that were still queued at suspend.
 *     revive() re-enqueues them; losing one destroys a user's message with no error.
 *   - parentId — the subagent hierarchy, which shares a sandbox pod with its parent.
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

/**
 * A tiny in-memory stand-in for the pg Pool covering the statements this store issues,
 * honouring the id primary key and both conflict actions.
 */
function fakeDb(): { db: NodePgDatabase; rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();

  // Column order must match lib/sql/agent_host/schema.sql: drizzle's bare .select()
  // asks for rowMode:"array" and maps positionally.
  const ORDER = [
    "id", "thread_id", "title", "created_at", "last_activity_at",
    "model", "owner", "parent_id", "user_titled", "starred", "pending_queue",
  ] as const;

  const client = {
    async query(cfg: { text: string; values?: unknown[] } | string, params: unknown[] = []) {
      const text = typeof cfg === "string" ? cfg : cfg.text;
      const values = (typeof cfg === "string" ? params : (cfg.values ?? params)) as unknown[];
      const head = text.trim().toUpperCase();

      if (head.startsWith("INSERT")) {
        const [id, threadId, title, createdAt, lastActivityAt, model, owner, parentId, userTitled, starred, pendingQueue] =
          values as [string, string, string, number, number, string | null, string | null, string | null, boolean | null, boolean | null, unknown];
        if (rows.has(id) && !/DO UPDATE/i.test(text)) return { rows: [], rowCount: 0 };
        rows.set(id, {
          id,
          thread_id: threadId,
          title,
          // node-postgres returns bigint columns as STRINGS.
          created_at: String(createdAt),
          last_activity_at: String(lastActivityAt),
          model,
          owner,
          parent_id: parentId,
          user_titled: userTitled,
          starred,
          pending_queue: pendingQueue,
        });
        return { rows: [], rowCount: 1 };
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
  return { db: drizzle(client as never), rows };
}

/** A file-backed store standing in for one a deployment still carries on disk. */
const legacyWith = (metas: ConversationMeta[]) => ({
  listConversations: vi.fn(async () => metas),
});

describe("conversation metadata in Postgres", () => {
  it("THE ROLLOUT SHAPE: conversations list when the file store is wiped", async () => {
    const store = createPgMetaStore({ db: fakeDb().db, legacy: legacyWith([]) });

    await store.saveMeta(meta({ id: "conv-1" as SessionId }));
    await store.saveMeta(meta({ id: "conv-2" as SessionId }));

    expect((await store.listConversations()).map((m) => m.id).sort()).toEqual(["conv-1", "conv-2"]);
  });

  it("round-trips every field", async () => {
    const store = createPgMetaStore({ db: fakeDb().db });
    const full = meta({
      model: "claude-opus-4",
      owner: "user@example.com",
      parentId: "conv-parent" as SessionId,
      userTitled: true,
      starred: true,
      pendingQueue: [{ text: "the queued message", priority: 1 }],
    });

    await store.saveMeta(full);
    expect((await store.listConversations())[0]).toEqual(full);
  });

  it("PRESERVES pendingQueue — a user's undelivered message is not lost", async () => {
    const store = createPgMetaStore({ db: fakeDb().db });
    await store.saveMeta(
      meta({ pendingQueue: [{ text: "first", priority: 0 }, { text: "second", priority: 1 }] }),
    );

    expect((await store.listConversations())[0].pendingQueue).toEqual([
      { text: "first", priority: 0 },
      { text: "second", priority: 1 },
    ]);
  });

  it("persists a CLEARED queue as empty, not absent", async () => {
    // revive() clears the queue after re-enqueuing. Collapsing [] to NULL would make the
    // next hydrate re-deliver messages the user already received.
    const { db, rows } = fakeDb();
    const store = createPgMetaStore({ db });
    await store.saveMeta(meta({ pendingQueue: [{ text: "queued", priority: 0 }] }));
    await store.saveMeta(meta({ pendingQueue: [] }));

    expect((await store.listConversations())[0].pendingQueue).toEqual([]);
  });

  it("parses a pendingQueue delivered as raw jsonb text", async () => {
    const { db, rows } = fakeDb();
    const store = createPgMetaStore({ db });
    await store.saveMeta(meta({ pendingQueue: [{ text: "q", priority: 0 }] }));
    rows.get("conv-1")!.pending_queue = JSON.stringify([{ text: "q", priority: 0 }]);

    expect((await store.listConversations())[0].pendingQueue).toEqual([{ text: "q", priority: 0 }]);
  });

  it("PRESERVES parentId — the subagent hierarchy survives", async () => {
    const store = createPgMetaStore({ db: fakeDb().db });
    await store.saveMeta(meta({ id: "sub-1" as SessionId, parentId: "conv-root" as SessionId }));

    expect((await store.listConversations())[0].parentId).toBe("conv-root");
  });

  it("coerces bigint timestamps back to numbers", async () => {
    // The idle sweep and the sidebar sort do arithmetic on these.
    const store = createPgMetaStore({ db: fakeDb().db });
    await store.saveMeta(meta({ createdAt: 1_700_000_000_000, lastActivityAt: 1_700_000_009_999 }));

    const [got] = await store.listConversations();
    expect(got.createdAt).toBe(1_700_000_000_000);
    expect(got.lastActivityAt).toBe(1_700_000_009_999);
  });

  it("omits absent optionals rather than materializing them as null", async () => {
    const store = createPgMetaStore({ db: fakeDb().db });
    await store.saveMeta(meta());

    const [got] = await store.listConversations();
    expect(got).not.toHaveProperty("model");
    expect(got).not.toHaveProperty("owner");
    expect(got).not.toHaveProperty("parentId");
  });

  it("saveMeta UPDATES an existing conversation in place", async () => {
    const store = createPgMetaStore({ db: fakeDb().db });
    await store.saveMeta(meta({ title: "New chat" }));
    await store.saveMeta(meta({ title: "Renamed", userTitled: true }));

    const listed = await store.listConversations();
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("Renamed");
    expect(listed[0].userTitled).toBe(true);
  });

  it("orders the list by recency", async () => {
    const store = createPgMetaStore({ db: fakeDb().db });
    await store.saveMeta(meta({ id: "older" as SessionId, lastActivityAt: 1_000 }));
    await store.saveMeta(meta({ id: "newer" as SessionId, lastActivityAt: 9_000 }));

    expect((await store.listConversations()).map((m) => m.id)).toEqual(["newer", "older"]);
  });

  it("removeConversation keeps it from coming back", async () => {
    const store = createPgMetaStore({ db: fakeDb().db });
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

    await store.listConversations(); // seeds
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

    await store.listConversations(); // seeds
    legacy.listConversations.mockClear();

    const [got] = await store.listConversations();
    expect(got.parentId).toBe("root");
    expect(got.pendingQueue).toEqual([{ text: "not yet delivered", priority: 2 }]);
  });

  it("does not seed once the database has any conversation", async () => {
    const legacy = legacyWith([meta({ id: "on-disk" as SessionId })]);
    const store = createPgMetaStore({ db: fakeDb().db, legacy });

    await store.saveMeta(meta({ id: "live" as SessionId }));
    expect((await store.listConversations()).map((m) => m.id)).toEqual(["live"]);
    expect(legacy.listConversations).not.toHaveBeenCalled();
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
    // Answering [] for "I could not read them" is how an entire sidebar goes blank while
    // the data is intact. The caller must be able to tell the difference.
    const store = createPgMetaStore({ db: brokenDb() });
    await expect(store.listConversations()).rejects.toThrow();
  });

  it("saveMeta degrades quietly — a metadata write must not fail the turn", async () => {
    const store = createPgMetaStore({ db: brokenDb() });
    await expect(store.saveMeta(meta())).resolves.toBeUndefined();
  });
});
