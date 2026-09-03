/**
 * Durable per-user remote-agent binding, on the shared Postgres. Persists that an owner has
 * connected a BYO Claude agent so the "Connected" badge is correct ACROSS replicas + survives an
 * agent-host restart (the in-memory registry lives on one replica only). Best-effort: a DB blip
 * degrades the badge to "offline", never breaks a connection or a request.
 *
 * Two-tier truth (see todo/docs/BYO_CLAUDE_REMOTE_AGENT.md):
 *   - DB status  → the BADGE (any replica can read it; survives restart).
 *   - live registry (in-memory, owning replica) → ROUTING (a prompt only goes to a genuinely-open
 *     WS; a stale DB "online" after a crash just falls to the cloud floor — RUN_ERROR-safe).
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { byoc } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

const { remoteAgents } = byoc;

const log = logger("remoteAgentStore");

export interface RemoteAgentBinding {
  owner: string;
  status: "online" | "offline";
  lastSeen?: string;
}

/** The persistence seam (Postgres impl below; tests inject a fake). */
export interface RemoteAgentStore {
  /** Upsert the owner ONLINE (on WS connect). */
  markOnline(owner: string): Promise<void>;
  /** Mark the owner OFFLINE (on WS close) — but only if `transportStillCurrent` (a late close of a
   *  superseded connection must not flip a freshly-reconnected owner offline). */
  markOffline(owner: string): Promise<void>;
  /** Is this owner's agent believed online (for the badge)? false on any error. */
  isOnline(owner: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface PgRemoteAgentStoreConfig {
  dsn: string;
}

/** Postgres-backed store on the BYOC database via the generated @scooter/schema Drizzle
 *  client. `remote_agents` used to exist twice — a webhooks copy written here and a byoc
 *  copy written by byoc-controller, same entity, no synchronisation. There is now one
 *  table (lib/sql/byoc/schema.sql) with two writers: byoc-controller owns session_id, this
 *  store owns the status/last_seen badge. It never touches session_id, so the two writers
 *  cannot clobber each other. All errors swallowed (best-effort). PR #423. */
export function createPgRemoteAgentStore(config: PgRemoteAgentStoreConfig): RemoteAgentStore {
  const pool = createPgPool("remoteAgentStore", { connectionString: config.dsn, max: 2 });
  const db = drizzle(pool);

  return {
    async markOnline(owner) {
      try {
        await db
          .insert(remoteAgents)
          .values({ owner, status: "online", lastSeen: sql`now()` })
          .onConflictDoUpdate({
            target: remoteAgents.owner,
            set: { status: "online", lastSeen: sql`now()` },
          });
      } catch (e) {
        log.error("markOnline failed", { owner, error: formatError(e) });
      }
    },
    async markOffline(owner) {
      try {
        await db
          .update(remoteAgents)
          .set({ status: "offline", lastSeen: sql`now()` })
          .where(eq(remoteAgents.owner, owner));
      } catch (e) {
        log.error("markOffline failed", { owner, error: formatError(e) });
      }
    },
    async isOnline(owner) {
      try {
        const rows = await db
          .select({ status: remoteAgents.status })
          .from(remoteAgents)
          .where(eq(remoteAgents.owner, owner))
          .limit(1);
        return rows[0]?.status === "online";
      } catch (e) {
        log.error("isOnline failed", { owner, error: formatError(e) });
        return false;
      }
    },
    async close() {
      await pool.end().catch(() => {});
    },
  };
}
