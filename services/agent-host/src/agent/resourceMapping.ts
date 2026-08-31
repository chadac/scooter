/**
 * Resource-mapping lookup — the FALLBACK source for a conversation's external
 * target (slack channel/thread, GitHub PR, GitLab MR, Jira issue) when the
 * conversation's link has no structured `ref`.
 *
 * The webhooks service records every trigger in its Postgres `conversation_map`
 * table (source, resource_type, resource_id, conversation_id, + slack_channel/
 * slack_ts). The agent-tools (slack_respond, etc.) prefer the link `ref`, but a
 * conversation created before `ref` existed has a ref-less link — so we read the
 * mapping straight from that Postgres table as the backup, keyed by the
 * conversation id. Read-only, best-effort: any DB error yields `undefined` (the
 * tool then reports it can't determine the target — never a wrong guess).
 *
 * We query the SAME shared Postgres the webhooks service writes; the agent-host
 * deployment is given read access (DSN/DB_* env). When no DB is configured, the
 * factory returns undefined and the tools fall back to `ref` alone.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { webhooks } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

import type { ResourceMapping } from "./agentTools.js";

const { conversationMap } = webhooks;

const log = logger("resourceLookup");

export interface ResourceLookupConfig {
  /** Postgres connection string (postgresql://user:pass@host:port/db). */
  dsn: string;
}

export interface ResourceLookup {
  /** The webhooks conversation_map row for this conversation + source, or
   *  undefined if unmapped / on any DB error. */
  lookup(conversationId: string, source: string): Promise<ResourceMapping | undefined>;
  /** Close the pool (on shutdown). */
  close(): Promise<void>;
}

/**
 * Build a Postgres-backed ResourceLookup. The pool is lazy (first query
 * connects); a connection/query failure is logged and swallowed (returns
 * undefined) so a DB blip never breaks a tool call — the tool just falls back to
 * "target unknown".
 */
export function createResourceLookup(config: ResourceLookupConfig): ResourceLookup {
  // Hardened pool (idleTimeoutMillis + keepAlive) so a stale idle connection never
  // hangs a query — see db/pgPool.ts. The Drizzle client is a thin typed wrapper over
  // this same pool; a column rename in lib/sql (regenerated into @scooter/schema) is now
  // a compile error here, not a silent runtime failure. Why: PR #392 chain.
  const pool = createPgPool("resourceLookup", { connectionString: config.dsn, max: 3 });
  const db = drizzle(pool);

  return {
    async lookup(conversationId, source) {
      try {
        const rows = await db
          .select({
            source: conversationMap.source,
            resourceType: conversationMap.resourceType,
            resourceId: conversationMap.resourceId,
            slackChannel: conversationMap.slackChannel,
            slackTs: conversationMap.slackTs,
          })
          .from(conversationMap)
          .where(
            and(
              eq(conversationMap.conversationId, conversationId),
              eq(conversationMap.source, source),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) return undefined;
        return {
          source: row.source,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          slackChannel: row.slackChannel ?? undefined,
          slackTs: row.slackTs ?? undefined,
        };
      } catch (err) {
        log.error("query failed (falling back to ref-only)", {
          conversation_id: conversationId,
          source,
          error: formatError(err),
        });
        return undefined;
      }
    },
    async close() {
      await pool.end().catch(() => {});
    },
  };
}
