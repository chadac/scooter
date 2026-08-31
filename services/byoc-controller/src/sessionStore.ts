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

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { byoc } from "@scooter/schema";
import { Pool } from "pg";

import type { DeviceRow, DeviceStore } from "./deviceAuth.js";

const { remoteAgents } = byoc;

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
  // Read/write byoc.remote_agents through the generated @scooter/schema Drizzle client. The
  // table (with session_id) is declared in lib/sql/byoc/schema.sql and provisioned by the migrate
  // job, so this store no longer self-CREATE/ALTERs it — a column rename there is a compile error
  // here. Why: PR #407 chain.
  const db = drizzle(pool);

  return {
    async put(owner, sessionId) {
      try {
        await db
          .insert(remoteAgents)
          .values({ owner, sessionId, status: "offline", lastSeen: sql`now()` })
          .onConflictDoUpdate({
            target: remoteAgents.owner,
            set: { sessionId, status: "offline", lastSeen: sql`now()` },
          });
      } catch {
        /* best effort — the in-memory registry still serves this process */
      }
    },

    async setStatus(owner, status) {
      try {
        await db
          .update(remoteAgents)
          .set({ status, lastSeen: sql`now()` })
          .where(eq(remoteAgents.owner, owner));
      } catch {
        /* best effort */
      }
    },

    async getByOwner(owner) {
      try {
        const rows = await db
          .select({ owner: remoteAgents.owner, sessionId: remoteAgents.sessionId, status: remoteAgents.status })
          .from(remoteAgents)
          .where(eq(remoteAgents.owner, owner))
          .limit(1);
        const row = rows[0];
        if (!row?.sessionId) return null;
        return {
          owner: row.owner,
          sessionId: row.sessionId,
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


// --- Device store (§P) -------------------------------------------------------------------------

/** In-memory device store for local dev / tests. */
export function createMemoryDeviceStore(): DeviceStore {
  const rows = new Map<string, DeviceRow>();
  return {
    async add(d) { rows.set(d.id, { ...d }); },
    async listByOwner(owner) { return [...rows.values()].filter((r) => r.owner === owner).map((r) => ({ ...r })); },
    async getById(id) { const r = rows.get(id); return r ? { ...r } : undefined; },
    async remove(id) { rows.delete(id); },
    async touch(id, at) { const r = rows.get(id); if (r) r.lastSeen = at; },
    async close() { rows.clear(); },
  };
}

/**
 * Postgres-backed device store. A SEPARATE table from `remote_agents`, because devices are 1:N per
 * owner (laptop + desktop + spare) while `remote_agents` is keyed `owner PRIMARY KEY`.
 *
 * NOT best-effort, unlike the session store: a device row IS the credential. Swallowing a read
 * failure here would mean "unknown device" -> a working laptop silently rejected; swallowing a
 * write failure on deregister would mean a revoked key still authenticating. Errors propagate so
 * the caller fails closed and loudly.
 *
 * Still on hand-written SQL (and self-CREATEs remote_agent_devices): that table is NOT yet in
 * lib/sql/byoc/schema.sql, so there is no generated @scooter/schema table to adopt. Follow-up: add
 * remote_agent_devices to the byoc baseline schema, regenerate, then convert this store too. Why:
 * PR #407 chain.
 */
export function createPgDeviceStore(config: PgSessionStoreConfig): DeviceStore {
  const pool = new Pool({ connectionString: config.dsn, max: 4, keepAlive: true });
  let ready: Promise<void> | undefined;

  const ensure = (): Promise<void> => {
    ready ??= (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS remote_agent_devices (
           id          text PRIMARY KEY,
           owner       text NOT NULL,
           public_key  text NOT NULL,
           label       text,
           created_at  timestamptz NOT NULL DEFAULT now(),
           last_seen   timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // The hot query is "this owner's devices" (cap enforcement + the settings list).
      await pool.query(
        `CREATE INDEX IF NOT EXISTS remote_agent_devices_owner_idx ON remote_agent_devices (owner)`,
      );
    })().catch((err) => {
      ready = undefined; // let a later call retry rather than wedging on one bad startup
      throw err;
    });
    return ready;
  };

  const toRow = (r: { id: string; owner: string; public_key: string; label: string | null; last_seen: Date }): DeviceRow => ({
    id: r.id,
    owner: r.owner,
    publicKey: r.public_key,
    label: r.label ?? undefined,
    lastSeen: Math.floor(r.last_seen.getTime() / 1000),
  });

  return {
    async add(d) {
      await ensure();
      await pool.query(
        `INSERT INTO remote_agent_devices (id, owner, public_key, label, last_seen)
         VALUES ($1, $2, $3, $4, to_timestamp($5))`,
        [d.id, d.owner, d.publicKey, d.label ?? null, d.lastSeen],
      );
    },

    async listByOwner(owner) {
      await ensure();
      const r = await pool.query(
        `SELECT id, owner, public_key, label, last_seen FROM remote_agent_devices WHERE owner = $1`,
        [owner],
      );
      return r.rows.map(toRow);
    },

    async getById(id) {
      await ensure();
      const r = await pool.query(
        `SELECT id, owner, public_key, label, last_seen FROM remote_agent_devices WHERE id = $1`,
        [id],
      );
      return r.rows[0] ? toRow(r.rows[0]) : undefined;
    },

    async remove(id) {
      await ensure();
      await pool.query(`DELETE FROM remote_agent_devices WHERE id = $1`, [id]);
    },

    async touch(id, at) {
      await ensure();
      // last_seen drives BOTH the settings list and which device gets evicted at the cap, so a
      // missed touch would make an active laptop look idle and cost it its slot.
      await pool.query(`UPDATE remote_agent_devices SET last_seen = to_timestamp($2) WHERE id = $1`, [id, at]);
    },

    async close() {
      await pool.end().catch(() => {});
    },
  };
}
