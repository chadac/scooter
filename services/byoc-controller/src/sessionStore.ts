/**
 * The DURABLE half of a BYOC session: which owner has which session id, and whether it was last
 * seen online (§L Q4).
 *
 * Extends the `remote_agents` table #275 created. VERIFIED against that branch: it is
 * `(owner text PRIMARY KEY, status, last_seen)` with NO session column, so `session_id` is an ADD,
 * not a reuse as-is. `ADD COLUMN IF NOT EXISTS` keeps this compatible with a database where the
 * agent-host already created the table.
 *
 * WHAT IS NOT HERE: the socket. A TCP connection cannot outlive the process, and the container
 * reconnects on its own, so persisting liveness would only create a way to be WRONG — a stale
 * "online" row after a crash would send a prompt into a socket nobody is listening on. Liveness
 * comes from the in-memory socket map; this table is for the mapping and the UI badge.
 *
 * BEST EFFORT: every error is swallowed. A DB blip should degrade the badge, never break a live
 * connection or fail a request — the socket is the thing that actually matters.
 */

import { Pool } from "pg";

export interface SessionRow {
  owner: string;
  sessionId: string;
  status: "online" | "offline";
}

export interface SessionStore {
  put(owner: string, sessionId: string): Promise<void>;
  setStatus(owner: string, status: "online" | "offline"): Promise<void>;
  getByOwner(owner: string): Promise<SessionRow | null>;
  close(): Promise<void>;
}

/** In-memory store for local dev / tests. The mapping does not survive a restart. */
export function createMemorySessionStore(): SessionStore {
  const rows = new Map<string, SessionRow>();
  return {
    async put(owner, sessionId) {
      rows.set(owner, { owner, sessionId, status: "offline" });
    },
    async setStatus(owner, status) {
      const r = rows.get(owner);
      if (r) r.status = status;
    },
    async getByOwner(owner) {
      return rows.get(owner) ?? null;
    },
    async close() {
      rows.clear();
    },
  };
}

export interface PgSessionStoreConfig {
  dsn: string;
}

export function createPgSessionStore(config: PgSessionStoreConfig): SessionStore {
  // pool_pre_ping equivalent: `keepAlive` plus a bounded pool. The broker/scheduler learned this
  // the hard way — an engine with no reconnect guard dies permanently on a postgres restart.
  const pool = new Pool({ connectionString: config.dsn, max: 4, keepAlive: true });
  let ready: Promise<void> | undefined;

  // Lazy migration on first use, so the service starts even if the DB is briefly unavailable.
  const ensure = (): Promise<void> => {
    ready ??= (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS remote_agents (
           owner text PRIMARY KEY,
           status text NOT NULL DEFAULT 'offline',
           last_seen timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // The ADD this controller needs. Separate from CREATE so it also applies to a table the
      // agent-host created first.
      await pool.query(`ALTER TABLE remote_agents ADD COLUMN IF NOT EXISTS session_id text`);
    })().catch((err) => {
      ready = undefined; // let a later call retry rather than wedging on one bad startup
      throw err;
    });
    return ready;
  };

  return {
    async put(owner, sessionId) {
      try {
        await ensure();
        await pool.query(
          `INSERT INTO remote_agents (owner, session_id, status, last_seen)
           VALUES ($1, $2, 'offline', now())
           ON CONFLICT (owner) DO UPDATE SET session_id = $2, status = 'offline', last_seen = now()`,
          [owner, sessionId],
        );
      } catch {
        /* best effort — the in-memory registry still serves this process */
      }
    },

    async setStatus(owner, status) {
      try {
        await ensure();
        await pool.query(
          `UPDATE remote_agents SET status = $2, last_seen = now() WHERE owner = $1`,
          [owner, status],
        );
      } catch {
        /* best effort */
      }
    },

    async getByOwner(owner) {
      try {
        await ensure();
        const r = await pool.query<{ owner: string; session_id: string | null; status: string }>(
          `SELECT owner, session_id, status FROM remote_agents WHERE owner = $1`,
          [owner],
        );
        const row = r.rows[0];
        if (!row?.session_id) return null;
        return {
          owner: row.owner,
          sessionId: row.session_id,
          status: row.status === "online" ? "online" : "offline",
        };
      } catch {
        return null; // a DB blip reads as "no durable session", never as a wrong one
      }
    },

    async close() {
      await pool.end().catch(() => {});
    },
  };
}
