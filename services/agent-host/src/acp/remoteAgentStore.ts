/**
 * Durable per-user remote-agent binding, on the shared Postgres. Persists that an owner has
 * connected a BYO Claude agent so the "Connected" badge is correct ACROSS replicas + survives an
 * agent-host restart (the in-memory registry lives on one replica only). Best-effort: a DB blip
 * degrades the badge to "offline", never breaks a connection or a request.
 *
 * Two-tier truth:
 *   - DB status  → the BADGE (any replica can read it; survives restart).
 *   - live registry (in-memory, owning replica) → ROUTING (a prompt only goes to a genuinely-open
 *     WS; a stale DB "online" after a crash just falls to the cloud floor — RUN_ERROR-safe).
 */

import { createPgPool } from "../db/pgPool.js";

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

/** Postgres-backed store on the shared DB. Lazy pool + CREATE TABLE IF NOT EXISTS on first use (no
 *  migration). All errors swallowed (best-effort). */
export function createPgRemoteAgentStore(config: PgRemoteAgentStoreConfig): RemoteAgentStore {
  const pool = createPgPool("remoteAgentStore", { connectionString: config.dsn, max: 2 });

  let ensured: Promise<void> | undefined;
  const ensureTable = (): Promise<void> => {
    ensured ??= pool
      .query(
        `CREATE TABLE IF NOT EXISTS remote_agents (
           owner text PRIMARY KEY,
           status text NOT NULL DEFAULT 'offline',
           last_seen timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined)
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[remoteAgentStore] ensure table failed (badge persistence off):", (e as Error).message);
        ensured = undefined; // retry next call
      });
    return ensured;
  };

  return {
    async markOnline(owner) {
      try {
        await ensureTable();
        await pool.query(
          `INSERT INTO remote_agents (owner, status, last_seen)
             VALUES ($1, 'online', now())
           ON CONFLICT (owner) DO UPDATE SET status = 'online', last_seen = now()`,
          [owner],
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[remoteAgentStore] markOnline(${owner}) failed:`, (e as Error).message);
      }
    },
    async markOffline(owner) {
      try {
        await ensureTable();
        await pool.query(
          `UPDATE remote_agents SET status = 'offline', last_seen = now() WHERE owner = $1`,
          [owner],
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[remoteAgentStore] markOffline(${owner}) failed:`, (e as Error).message);
      }
    },
    async isOnline(owner) {
      try {
        await ensureTable();
        const res = await pool.query(`SELECT status FROM remote_agents WHERE owner = $1 LIMIT 1`, [owner]);
        return res.rows[0]?.status === "online";
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[remoteAgentStore] isOnline(${owner}) failed:`, (e as Error).message);
        return false;
      }
    },
    async close() {
      await pool.end().catch(() => {});
    },
  };
}
