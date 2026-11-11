/**
 * Durable external-resource links on the shared Postgres: the GitHub PR / GitLab MR /
 * Slack thread / Jira ticket a conversation is working on, shown in the UI's
 * linked-resources panel and used by the response tools to infer where to reply. Shares
 * the `resource_links` table webhooks owns, so one link is one row and the reverse lookup
 * has a single answer; this store never issues DDL. `resource_id` (see resourceIdOf) is the
 * identity a link is deduped on. A DB failure logs and degrades to an empty panel, never
 * throwing into a request.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { webhooks } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool, DbUnavailableError, retryReadOnce } from "../db/pgPool.js";
import { canonicalResourceType, type LinkTypeAliases } from "./linkTypeAliases.js";

import type { ConversationLink, LinkClash } from "./manager.js";
import type { SessionId } from "../types.js";

const log = logger("linkStore");

const { conversationVars, resourceLinks } = webhooks;

/** The store seam the ConversationStore's link methods delegate to. */
export interface LinkStore {
  /** A clash when another conversation owns the resource; undefined otherwise, DB failures included. */
  addLink(id: SessionId, link: ConversationLink): Promise<LinkClash | undefined>;
  listLinks(id: SessionId): Promise<ConversationLink[]>;
  /** Which conversation owns this resource, or undefined. */
  conversationForResource(
    source: string,
    resourceType: string,
    resourceId: string,
  ): Promise<string | undefined>;
  /** Drop every link and hidden variable of a deleted conversation. An orphan link would block a later conversation
   *  from linking the same resource on the global unique. */
  deleteByConversation(id: SessionId): Promise<void>;
  close(): Promise<void>;
}

export interface PgLinkStoreConfig {
  /** Postgres connection string. Ignored when `db` is supplied. */
  dsn?: string;
  /** Override the database handle (tests). Defaults to a hardened pool over `dsn`. */
  db?: NodePgDatabase;
  /**
   * File-backed links to read through to on a Postgres miss, backfilled and served.
   */
  legacy?: Pick<LinkStore, "listLinks">;
  /** Contribs' resourceType spellings, canonicalised on write since they key the upsert. */
  typeAliases?: LinkTypeAliases;
}

/**
 * The identity a link is deduped on: the url, else the Slack thread in `ref`, else the
 * title, else empty (source+type alone identify it).
 */
export function resourceIdOf(link: ConversationLink): string {
  return link.url ?? slackThreadId(link) ?? link.title ?? "";
}

/** `channel:threadTs`, the id webhooks' conversation_map gives the same thread. */
function slackThreadId(link: ConversationLink): string | undefined {
  if (link.source !== "slack") return undefined;
  const { channel, threadTs } = link.ref ?? {};
  return channel && threadTs ? `${channel}:${threadTs}` : undefined;
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
      // Canonical spelling, because it is part of the unique key this upsert conflicts on.
      resourceType: canonicalResourceType(config.typeAliases ?? {}, link.source, link.resourceType),
      resourceId: resourceIdOf(link),
      url: link.url ?? null,
      title: link.title ?? null,
      ref: link.ref ?? null,
    };
    // The conflict target is the global unique webhooks declares, not the conversation, so one
    // resource is one row.
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
          // Never touch another conversation's row; zero rows tells addLink it clashed.
          setWhere: sql`${resourceLinks.conversationId} = excluded.conversation_id`,
        })
      : await q.onConflictDoNothing({ target });
    return res.rowCount ?? 0;
  };

  /** Copy file-backed links into Postgres once, with DO NOTHING so a row already present always
   *  wins. */
  const backfill = async (id: string, links: ConversationLink[]): Promise<void> => {
    for (const link of links) await insert(id, link, false);
    log.info("backfilled file links into postgres", { conversation_id: id, links: links.length });
  };

  const store: LinkStore = {
    async addLink(id, link) {
      let stored: number;
      try {
        // Upsert so a re-post with a newly-known title or ref enriches the row, while coalesce
        // keeps what is already there if the new write is sparser.
        stored = await insert(id, link, true);
      } catch (e) {
        log.error("addLink failed (link not persisted)", {
          conversation_id: id,
          source: link.source,
          error: formatError(e),
        });
        return undefined;
      }
      if (stored > 0) return undefined;
      const resourceType = canonicalResourceType(config.typeAliases ?? {}, link.source, link.resourceType);
      const resourceId = resourceIdOf(link);
      const owner = await store.conversationForResource(link.source, resourceType, resourceId);
      log.warn("link not stored: another conversation owns the resource", {
        conversation_id: id,
        owner_conversation_id: owner,
        source: link.source,
        resource_type: resourceType,
        resource_id: resourceId,
      });
      return { ownerConversationId: owner };
    },

    async listLinks(id) {
      let rows: ConversationLink[] = [];
      try {
        const res = await retryReadOnce("listLinks", () =>
          db
            .select({
              source: resourceLinks.source,
              resourceType: resourceLinks.resourceType,
              url: resourceLinks.url,
              title: resourceLinks.title,
              ref: resourceLinks.ref,
            })
            .from(resourceLinks)
            .where(eq(resourceLinks.conversationId, id))
            .orderBy(asc(resourceLinks.id)),
        );
        rows = (res as LinkRow[]).map(rowToLink);
      } catch (e) {
        log.error("listLinks query failed", { conversation_id: id, error: formatError(e) });
        // An empty list would read as "no links" and backfill into a database that is down.
        if (e instanceof DbUnavailableError) throw e;
      }
      if (rows.length > 0 || !config.legacy) return rows;

      // Nothing in Postgres: read through to the file links and backfill so the next read is served
      // from here.
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
        // LIMIT 1 with DESC order is belt-and-braces: the global unique means at most one row.
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
      // Separate try: a failure here must not keep the links alive, or vice versa.
      try {
        await db.delete(conversationVars).where(eq(conversationVars.conversationId, id));
      } catch (e) {
        log.error("deleting conversation vars failed (they may outlive the deleted conversation)", {
          conversation_id: id,
          error: formatError(e),
        });
      }
    },

    async close() {
      await ownPool?.end().catch(() => {});
    },
  };
  return store;
}
