/**
 * Durable conversation METADATA on the shared Postgres — the record behind the sidebar
 * list and everything hydrate() rebuilds an in-memory conversation from.
 *
 * This is what makes listConversations a QUERY instead of a directory walk: the file
 * store read every conversation's meta.json on every list, which is one syscall per
 * conversation per call, and it read them from LOCAL_STATE_PATH — an emptyDir wiped on
 * every rollout.
 *
 * A ConversationMeta is not six scalars. Two fields carry real weight and must survive
 * the round trip exactly:
 *   - pendingQueue: messages the user already sent that were still QUEUED when the
 *     conversation was suspended. revive() re-enqueues them. Dropping it destroys a
 *     user's message silently — it never runs and never errors.
 *   - parentId: the subagent hierarchy. A subagent shares its parent's sandbox pod, so
 *     losing the link orphans the tree.
 *
 * Best-effort on errors with ONE exception: listConversations must never answer [] after
 * a failed query. Returning "no conversations" for "I could not read them" is how an
 * entire sidebar goes blank while the data is intact, so a list failure propagates.
 */

import { desc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

import type { ConversationMeta } from "./manager.js";
import type { SessionId, ThreadId } from "../types.js";

const log = logger("metaStore");

const { conversations } = agent_host;

/** The store seam the ConversationStore's meta methods delegate to. */
export interface MetaStore {
  saveMeta(meta: ConversationMeta): Promise<void>;
  listConversations(): Promise<ConversationMeta[]>;
  removeConversation(id: SessionId): Promise<void>;
  close(): Promise<void>;
}


export interface PgMetaStoreConfig {
  /** Postgres connection string. Ignored when `db` is supplied. */
  dsn?: string;
  /** Override the database handle (tests). Defaults to a hardened pool over `dsn`. */
  db?: NodePgDatabase;
  /**
   * File-backed metadata to seed from when Postgres holds no conversations at all.
   * Backfilled once, so a deployment's existing history appears on first boot.
   */
  legacy?: Pick<MetaStore, "listConversations">;
}

type MetaRow = {
  id: string;
  threadId: string;
  title: string;
  createdAt: string | number;
  lastActivityAt: string | number;
  model: string | null;
  owner: string | null;
  parentId: string | null;
  userTitled: boolean | null;
  starred: boolean | null;
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
    // bigint comes back as a string from node-postgres; these are ms-epoch numbers the
    // idle sweep and the sidebar sort do arithmetic on.
    createdAt: Number(row.createdAt),
    lastActivityAt: Number(row.lastActivityAt),
    ...(row.model == null ? {} : { model: row.model }),
    ...(row.owner == null ? {} : { owner: row.owner }),
    ...(row.parentId == null ? {} : { parentId: row.parentId as SessionId }),
    ...(row.userTitled == null ? {} : { userTitled: row.userTitled }),
    ...(row.starred == null ? {} : { starred: row.starred }),
    ...(row.pendingQueue == null
      ? {}
      : {
          pendingQueue:
            typeof row.pendingQueue === "string"
              ? JSON.parse(row.pendingQueue)
              : (row.pendingQueue as ConversationMeta["pendingQueue"]),
        }),
  });

  const upsert = async (meta: ConversationMeta, overwrite: boolean): Promise<void> => {
    const values = {
      id: meta.id,
      threadId: meta.threadId,
      title: meta.title ?? "",
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      model: meta.model ?? null,
      owner: meta.owner ?? null,
      parentId: meta.parentId ?? null,
      userTitled: meta.userTitled ?? null,
      starred: meta.starred ?? null,
      // A CLEARED queue must persist as an empty array, not vanish: revive() clears it
      // after re-enqueuing, and collapsing that to NULL would re-deliver the messages.
      pendingQueue: meta.pendingQueue === undefined ? null : meta.pendingQueue,
    };
    const q = db.insert(conversations).values(values);
    await (overwrite
      ? q.onConflictDoUpdate({ target: conversations.id, set: values })
      : q.onConflictDoNothing({ target: conversations.id }));
  };

  /** Seed from a file store the first time this table is empty. DO NOTHING so a row
   *  already present always wins. */
  const backfill = async (metas: ConversationMeta[]): Promise<void> => {
    for (const meta of metas) await upsert(meta, false);
    log.info("backfilled file conversation metadata into postgres", { conversations: metas.length });
  };

  return {
    async saveMeta(meta) {
      try {
        await upsert(meta, true);
      } catch (e) {
        log.error("saveMeta failed (metadata not persisted)", {
          conversation_id: meta.id,
          error: formatError(e),
        });
      }
    },

    async listConversations() {
      // NOT best-effort: answering [] for a failed read is what blanks a sidebar while
      // the data is intact. Let the caller see the failure.
      const res = await db.select().from(conversations).orderBy(desc(conversations.lastActivityAt));
      const rows = (res as MetaRow[]).map(rowToMeta);
      if (rows.length > 0 || !config.legacy) return rows;

      // The table is empty: either this is a fresh deployment, or its history is still
      // only on disk. Seed once so the sidebar is not blank on the first boot after
      // cutting over.
      const legacy = await config.legacy.listConversations();
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
