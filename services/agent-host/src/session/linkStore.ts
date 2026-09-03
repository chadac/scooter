/**
 * Durable external-resource LINKS on the shared Postgres — the GitHub PR / GitLab MR /
 * Slack thread / Jira ticket a conversation is working on, shown in the UI's linked-
 * resources panel and used by the response tools to infer where to reply.
 *
 * This must not be a file: `listLinks` read LOCAL_STATE_PATH, an emptyDir wiped on every
 * rollout, so a conversation's PR links became permanently invisible while the durable
 * mirror still held them.
 *
 * Shares the `resource_links` table webhooks OWNS, so one link is one row and the
 * reverse lookup ("which conversation owns this PR?") has a single answer. url/title/ref
 * are declared in lib/sql/webhooks/schema.sql and nullable, so a webhooks-written row
 * stays valid; this store never issues DDL.
 *
 * `resource_id` is the stable identity a link is deduped on. The webhooks service sets
 * it explicitly; a link arriving from the agent-host API carries a url/title instead, so
 * we derive it the same way the file store's dedupe key did (url, else title) — two
 * writes describing the same resource must not produce two rows.
 *
 * Best-effort on errors: a DB failure logs and degrades to an empty panel, never throws
 * into a request. An empty panel during an outage beats one that is permanently wrong.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { webhooks } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

import type { ConversationLink } from "./manager.js";
import type { SessionId } from "../types.js";

const log = logger("linkStore");

const { resourceLinks } = webhooks;

/** The store seam the ConversationStore's link methods delegate to. */
export interface LinkStore {
  addLink(id: SessionId, link: ConversationLink): Promise<void>;
  listLinks(id: SessionId): Promise<ConversationLink[]>;
  /** Which conversation owns this resource, or undefined. The reverse lookup a file
   *  store could never answer without scanning every conversation directory. */
  conversationForResource(
    source: string,
    resourceType: string,
    resourceId: string,
  ): Promise<string | undefined>;
  /** Drop every link of a conversation — called when the conversation itself is deleted, so
   *  its rows in the shared resource_links table don't outlive it. The file store dropped links
   *  implicitly with the conversation's directory; the durable table needs an explicit delete
   *  (else a later conversation that links the SAME resource collides with the orphan on the
   *  global (source, resource_type, resource_id) unique and never gets its own row). */
  deleteByConversation(id: SessionId): Promise<void>;
  close(): Promise<void>;
}

export interface PgLinkStoreConfig {
  /** Postgres connection string. Ignored when `db` is supplied. */
  dsn?: string;
  /** Override the database handle (tests). Defaults to a hardened pool over `dsn`. */
  db?: NodePgDatabase;
  /**
   * File-backed links to read through to on a Postgres miss. Rows found there are
   * backfilled and served, so a conversation whose links are still only on disk keeps
   * showing them. Omit once no deployment has file links left.
   */
  legacy?: Pick<LinkStore, "listLinks">;
}

/**
 * The identity a link is deduped on. Mirrors the file store's key so a link written
 * before and after this store resolve to the same row: prefer the url, else the title.
 * Empty when a link carries neither, in which case source+type alone identify it.
 */
export function resourceIdOf(link: ConversationLink): string {
  return link.url ?? link.title ?? "";
}

export function createPgLinkStore(config: PgLinkStoreConfig): LinkStore {
  // Own the pool only when we made it, so close() cannot end a caller's handle.
  const ownPool = config.db ? undefined : createPgPool("linkStore", { connectionString: config.dsn!, max: 3 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);

  type LinkRow = {
    source: string;
    resourceType: string;
    url: string | null;
    title: string | null;
    ref: ConversationLink["ref"] | string | null;
  };

  const rowToLink = (row: LinkRow): ConversationLink => ({
    source: row.source,
    resourceType: row.resourceType,
    ...(row.url == null ? {} : { url: row.url }),
    ...(row.title == null ? {} : { title: row.title }),
    // jsonb arrives parsed, but a driver configured to return raw text must not
    // produce a string where the tools expect an object.
    ...(row.ref == null
      ? {}
      : { ref: typeof row.ref === "string" ? JSON.parse(row.ref) : row.ref }),
  });

  const insert = async (id: string, link: ConversationLink, overwrite: boolean): Promise<number> => {
    const values = {
      conversationId: id,
      source: link.source,
      resourceType: link.resourceType,
      resourceId: resourceIdOf(link),
      url: link.url ?? null,
      title: link.title ?? null,
      ref: link.ref ?? null,
    };
    // The conflict target is the GLOBAL unique webhooks declares — (source,
    // resource_type, resource_id), NOT the conversation. One resource is one row, which
    // is what keeps webhooks' reverse lookup single-valued.
    const target = [resourceLinks.source, resourceLinks.resourceType, resourceLinks.resourceId];
    const q = db.insert(resourceLinks).values(values);
    const res = overwrite
      ? await q.onConflictDoUpdate({
          target,
          // coalesce: a sparser re-post must not blank a title/ref we already have.
          set: {
            url: sql`coalesce(excluded.url, ${resourceLinks.url})`,
            title: sql`coalesce(excluded.title, ${resourceLinks.title})`,
            ref: sql`coalesce(excluded.ref, ${resourceLinks.ref})`,
          },
        })
      : await q.onConflictDoNothing({ target });
    return res.rowCount ?? 0;
  };

  /** Copy file-backed links into Postgres once. DO NOTHING so a row already present
   *  always wins — a backfill must never overwrite a fresher title/ref. */
  const backfill = async (id: string, links: ConversationLink[]): Promise<void> => {
    for (const link of links) await insert(id, link, false);
    log.info("backfilled file links into postgres", { conversation_id: id, links: links.length });
  };

  return {
    async addLink(id, link) {
      try {
        // Upsert: re-posting a link with a newly-known title or ref must ENRICH the row
        // (the webhooks service posts a bare link first, then fills in structured
        // targets), while COALESCE keeps what we already have if the new write is
        // sparser. A second identical post is a no-op, which is the dedupe.
        await insert(id, link, true);
      } catch (e) {
        log.error("addLink failed (link not persisted)", {
          conversation_id: id,
          source: link.source,
          error: formatError(e),
        });
      }
    },

    async listLinks(id) {
      let rows: ConversationLink[] = [];
      try {
        const res = await db
          .select({
            source: resourceLinks.source,
            resourceType: resourceLinks.resourceType,
            url: resourceLinks.url,
            title: resourceLinks.title,
            ref: resourceLinks.ref,
          })
          .from(resourceLinks)
          .where(eq(resourceLinks.conversationId, id))
          .orderBy(asc(resourceLinks.id));
        rows = (res as LinkRow[]).map(rowToLink);
      } catch (e) {
        log.error("listLinks query failed", { conversation_id: id, error: formatError(e) });
      }
      if (rows.length > 0 || !config.legacy) return rows;

      // Nothing in Postgres: either this conversation has no links, or they are still
      // only on disk. Read through and backfill so the next read is served from here.
      let legacy: ConversationLink[] = [];
      try {
        legacy = await config.legacy.listLinks(id);
      } catch (e) {
        log.error("file link read failed", { conversation_id: id, error: formatError(e) });
        return rows;
      }
      if (legacy.length === 0) return rows;
      await backfill(id, legacy).catch((e) =>
        log.error("link backfill failed (serving the file rows anyway)", {
          conversation_id: id,
          error: formatError(e),
        }),
      );
      return legacy;
    },

    async conversationForResource(source, resourceType, resourceId) {
      try {
        // LIMIT 1 with a DESC order is belt-and-braces: the global unique means there is
        // at most one row, so this cannot silently pick between rivals.
        const res = await db
          .select({ conversationId: resourceLinks.conversationId })
          .from(resourceLinks)
          .where(
            and(
              eq(resourceLinks.source, source),
              eq(resourceLinks.resourceType, resourceType),
              eq(resourceLinks.resourceId, resourceId),
            ),
          )
          .orderBy(desc(resourceLinks.id))
          .limit(1);
        return res[0]?.conversationId;
      } catch (e) {
        log.error("conversationForResource failed", {
          source,
          resource_type: resourceType,
          error: formatError(e),
        });
        return undefined;
      }
    },

    async deleteByConversation(id) {
      try {
        await db.delete(resourceLinks).where(eq(resourceLinks.conversationId, id));
      } catch (e) {
        log.error("deleteByConversation failed (links may outlive the deleted conversation)", {
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
