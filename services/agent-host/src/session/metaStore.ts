/**
 * Durable conversation metadata on the shared Postgres: the record behind the sidebar
 * list and everything hydrate() rebuilds an in-memory conversation from. pendingQueue
 * (messages still queued at suspend, which revive() re-enqueues) and parentId (the
 * subagent hierarchy) must survive the round trip exactly. Writes are best-effort, but
 * listConversations propagates a failed query rather than answering [] for data that is
 * intact.
 */

import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

import type { ConversationMeta, RouterMeta } from "./manager.js";
import type { AccessFacts, Visibility } from "./visibility.js";
import type { SessionId, ThreadId } from "../types.js";

const log = logger("metaStore");

const { conversations } = agent_host;

/** The store seam the ConversationStore's meta methods delegate to. */
export interface MetaStore {
  saveMeta(meta: ConversationMeta): Promise<void>;
  /** Raise a conversation's lastActivityAt to `at` (never lower it), from any replica. */
  touchActivity(id: SessionId, at: number): Promise<void>;
  /** Record a run starting (`running`) or ending at `at`, for the sidebar's active/unread dot. */
  setRunState(id: SessionId, running: boolean, at: number): Promise<void>;
  /** The persisted lastActivityAt, or undefined when there is no row. */
  readLastActivity(id: SessionId): Promise<number | undefined>;
  /** The router-owned star and title; undefined without a row, throws on failure. */
  readRouterMeta(id: SessionId): Promise<RouterMeta | undefined>;
  /** Filed conversations' folder lifetimes in hours, 0 = forever; throws. */
  readLifetimes(ids: SessionId[]): Promise<Map<SessionId, number>>;
  /** Set the visibility of `rootId` and all its descendants in one statement; throws on failure. */
  setVisibility(rootId: SessionId, visibility: Visibility): Promise<void>;
  /** The row's owner and visibility, undefined when there is no row; throws on a failed read. */
  readAccess(id: SessionId): Promise<AccessFacts | undefined>;
  listConversations(): Promise<ConversationMeta[]>;
  removeConversation(id: SessionId): Promise<void>;
  close(): Promise<void>;
}


export interface PgMetaStoreConfig {
  /** Postgres connection string, ignored when `db` is supplied. */
  dsn?: string;
  /** Override of the database handle for tests, defaulting to a hardened pool over `dsn`. */
  db?: NodePgDatabase;
  /** File-backed metadata to seed from when Postgres is empty at this process's first list. */
  legacy?: Pick<MetaStore, "listConversations">;
}

type MetaRow = {
  id: string;
  threadId: string;
  title: string;
  createdAt: string | number;
  lastActivityAt: string | number;
  model: string | null;
  modelSetBy: string | null;
  owner: string | null;
  parentId: string | null;
  userTitled: boolean | null;
  starred: boolean | null;
  visibility?: string | null;
  sandboxRef?: string | null;
  pendingQueue: unknown;
};

export function createPgMetaStore(config: PgMetaStoreConfig): MetaStore {
  // Own the pool only when we made it, so close() cannot end a caller's handle.
  const ownPool = config.db ? undefined : createPgPool("metaStore", { connectionString: config.dsn!, max: 3 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);

  const rowToMeta = (row: MetaRow): ConversationMeta => ({
    id: row.id as SessionId,
    threadId: row.threadId as ThreadId,
    title: row.title,
    // bigint comes back as a string from node-postgres.
    createdAt: Number(row.createdAt),
    lastActivityAt: Number(row.lastActivityAt),
    ...(row.model == null ? {} : { model: row.model }),
    ...(row.modelSetBy === "user" || row.modelSetBy === "agent" ? { modelSetBy: row.modelSetBy } : {}),
    ...(row.owner == null ? {} : { owner: row.owner }),
    ...(row.parentId == null ? {} : { parentId: row.parentId as SessionId }),
    ...(row.userTitled == null ? {} : { userTitled: row.userTitled }),
    ...(row.starred == null ? {} : { starred: row.starred }),
    ...(row.visibility === "private" ? { visibility: "private" as const } : {}),
    ...(row.sandboxRef == null ? {} : { sandboxRef: row.sandboxRef }),
    ...(row.pendingQueue == null
      ? {}
      : {
          pendingQueue:
            typeof row.pendingQueue === "string"
              ? JSON.parse(row.pendingQueue)
              : (row.pendingQueue as ConversationMeta["pendingQueue"]),
        }),
  });

  const rowValues = (meta: ConversationMeta) => {
    const values = {
      id: meta.id,
      threadId: meta.threadId,
      title: meta.title ?? "",
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      model: meta.model ?? null,
      modelSetBy: meta.modelSetBy ?? null,
      owner: meta.owner ?? null,
      parentId: meta.parentId ?? null,
      userTitled: meta.userTitled ?? null,
      starred: meta.starred ?? null,
      // A cleared queue must persist as an empty array, not NULL, or revive() would re-deliver the
      // messages.
      pendingQueue: meta.pendingQueue === undefined ? null : meta.pendingQueue,
    };
    return values;
  };

  // Set after the first successful list, so a table emptied by deletes is never re-seeded.
  let seedChecked = false;

  /** Seed from files; a backfilled conversation has no creator. */
  const backfill = async (metas: ConversationMeta[]): Promise<void> => {
    for (const meta of metas) {
      await db.insert(conversations).values(rowValues(meta)).onConflictDoNothing({ target: conversations.id });
    }
    log.info("backfilled file conversation metadata into postgres", { conversations: metas.length });
  };

  return {
    /** UPDATE only; a stale copy never unstars or unrenames. */
    async saveMeta(meta) {
      const { starred: _starred, userTitled: _userTitled, ...values } = rowValues(meta);
      try {
        await db
          .update(conversations)
          .set({
            ...values,
            title: sql`CASE WHEN ${conversations.userTitled} IS TRUE THEN ${conversations.title} ELSE ${values.title} END`,
            lastActivityAt: sql`GREATEST(${conversations.lastActivityAt}, ${meta.lastActivityAt})`,
          })
          .where(eq(conversations.id, meta.id));
      } catch (e) {
        log.error("saveMeta failed (metadata not persisted)", {
          conversation_id: meta.id,
          error: formatError(e),
        });
      }
    },

    async readRouterMeta(id) {
      const rows = await db
        .select({
          title: conversations.title,
          userTitled: conversations.userTitled,
          starred: conversations.starred,
          owner: conversations.owner,
          visibility: conversations.visibility,
        })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      if (!rows.length) return undefined;
      const r = rows[0];
      return {
        title: r.title,
        userTitled: r.userTitled === true,
        starred: r.starred === true,
        ...(r.owner == null ? {} : { owner: r.owner }),
        visibility: r.visibility === "private" ? "private" : "shared",
      };
    },

    async readLifetimes(ids) {
      // The owner's nearest set lifetime wins; the longest across placements.
      const res = await db.execute<{ id: string; hours: number }>(sql`
        WITH RECURSIVE up AS (
          SELECT c.id, f.parent_id,
                 CASE f.kind WHEN 'static' THEN s.conversation_lifetime_hours ELSE f.conversation_lifetime_hours END
                   AS lifetime_hours,
                 1 AS depth
          FROM conversations c
          JOIN user_conversation_metadata p ON p.conversation_id = c.id
            AND (c.owner IS NULL OR p.owner = c.owner OR p.owner = '')
          JOIN conversation_folders f ON f.id = p.folder_id
          LEFT JOIN static_folders s ON s.id = f.static_id
          WHERE c.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          UNION ALL
          SELECT up.id, f.parent_id, f.conversation_lifetime_hours, up.depth + 1
          FROM up JOIN conversation_folders f ON f.id = up.parent_id
          WHERE up.lifetime_hours IS NULL AND up.depth < 4
        )
        SELECT id, CASE WHEN bool_or(lifetime_hours = 0) THEN 0 ELSE max(lifetime_hours) END AS hours
        FROM up WHERE lifetime_hours IS NOT NULL GROUP BY id`);
      return new Map(res.rows.map((r) => [r.id, Number(r.hours)]));
    },

    async touchActivity(id, at) {
      try {
        await db
          .update(conversations)
          .set({ lastActivityAt: sql`GREATEST(${conversations.lastActivityAt}, ${at})` })
          .where(eq(conversations.id, id));
      } catch (e) {
        log.error("touchActivity failed (activity not persisted)", { conversation_id: id, error: formatError(e) });
      }
    },

    async setRunState(id, running, at) {
      try {
        if (running) {
          // The guard drops a start that lands after its own end; the two UPDATEs race.
          await db
            .update(conversations)
            .set({ runStartedAt: at })
            .where(and(eq(conversations.id, id), or(isNull(conversations.lastReplyAt), lt(conversations.lastReplyAt, at))));
        } else {
          await db
            .update(conversations)
            .set({ runStartedAt: null, lastReplyAt: sql`GREATEST(COALESCE(${conversations.lastReplyAt}, 0), ${at})` })
            .where(eq(conversations.id, id));
        }
      } catch (e) {
        log.error("setRunState failed (sidebar turn state not persisted)", { conversation_id: id, error: formatError(e) });
      }
    },

    async setVisibility(rootId, visibility) {
      // One statement over the whole subtree: a subagent shares its root's pod, so it can never
      // be less private. Not best-effort like saveMeta, since a lost write here fails open.
      await db.execute(sql`
        WITH RECURSIVE tree(id) AS (
          SELECT ${rootId}::text
          UNION SELECT c.id FROM ${conversations} c JOIN tree t ON c.parent_id = t.id
        )
        UPDATE ${conversations} SET visibility = ${visibility}
         WHERE id IN (SELECT id FROM tree)`);
    },

    async readAccess(id) {
      const rows = await db
        .select({ owner: conversations.owner, visibility: conversations.visibility })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      if (!rows.length) return undefined;
      return {
        ...(rows[0].owner == null ? {} : { owner: rows[0].owner }),
        visibility: rows[0].visibility === "private" ? "private" : "shared",
      };
    },

    async readLastActivity(id) {
      const rows = await db
        .select({ lastActivityAt: conversations.lastActivityAt })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      return rows.length ? Number(rows[0].lastActivityAt) : undefined;
    },

    async listConversations() {
      // Not best-effort: answering [] for a failed read blanks a sidebar while the data is intact.
      const res = await db.select().from(conversations).orderBy(desc(conversations.lastActivityAt));
      const rows = (res as MetaRow[]).map(rowToMeta);
      if (seedChecked || rows.length > 0 || !config.legacy) {
        seedChecked = true;
        return rows;
      }

      // The table is empty on first list: seed from the file store so the sidebar is not blank.
      const legacy = await config.legacy.listConversations();
      seedChecked = true;
      if (legacy.length === 0) return rows;
      await backfill(legacy).catch((e) =>
        log.error("metadata backfill failed (serving the file rows anyway)", {
          error: formatError(e),
        }),
      );
      return legacy;
    },

    async removeConversation(id) {
      try {
        await db.delete(conversations).where(eq(conversations.id, id));
      } catch (e) {
        log.error("removeConversation failed (it may reappear on the next hydrate)", {
          conversation_id: id,
          error: formatError(e),
        });
      }
    },

    async close() {
      await ownPool?.end().catch(() => {});
    },
  };
}
