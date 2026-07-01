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

import { Pool } from "pg";

import type { ResourceMapping } from "./agentTools.js";

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
  const pool = new Pool({ connectionString: config.dsn, max: 3, connectionTimeoutMillis: 5000 });
  // Don't let an idle-client error crash the process (pg emits 'error' on the pool
  // for backend/idle failures); log and continue.
  pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[resourceLookup] idle pg client error (non-fatal):", err.message);
  });

  return {
    async lookup(conversationId, source) {
      try {
        const res = await pool.query(
          `SELECT source, resource_type, resource_id, slack_channel, slack_ts
             FROM conversation_map
            WHERE conversation_id = $1 AND source = $2
            LIMIT 1`,
          [conversationId, source],
        );
        const row = res.rows[0];
        if (!row) return undefined;
        return {
          source: row.source,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          slackChannel: row.slack_channel ?? undefined,
          slackTs: row.slack_ts ?? undefined,
        };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[resourceLookup] query failed for ${conversationId}/${source} (falling back to ref-only):`, (err as Error).message);
        return undefined;
      }
    },
    async close() {
      await pool.end().catch(() => {});
    },
  };
}
