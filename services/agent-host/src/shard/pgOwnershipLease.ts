/**
 * Postgres OwnershipLease — the production impl on the shared DB. Must behave
 * identically to createInMemoryLease (the reference; see ownershipLease.ts +
 * the contract test). All grant/fence decisions are done in SINGLE atomic SQL
 * statements so concurrent routers/shards can't both win a conversation.
 *
 * Table `conversation_shard`:
 *   conversation_id text PRIMARY KEY
 *   owner_ord       int   NOT NULL   -- current owning shard
 *   generation      bigint NOT NULL  -- fencing token, bumped on every (re)acquire/steal
 *   expires_at      timestamptz NOT NULL
 *
 * "expired" = expires_at <= now(). Time is the DB's now() (single clock — avoids
 * shard clock skew), so the TTL is enforced server-side.
 */

import { Pool } from "pg";

import { DEFAULT_LEASE_TTL_MS, type Lease, type OwnershipLease } from "./ownershipLease.js";

export interface PgOwnershipLeaseConfig {
  dsn: string;
  ttlMs?: number;
}

interface Row {
  conversation_id: string;
  owner_ord: number;
  generation: string; // bigint comes back as string from pg
  expires_at: Date;
}

const rowToLease = (r: Row): Lease => ({
  conversationId: r.conversation_id,
  ownerOrd: r.owner_ord,
  generation: Number(r.generation),
  expiresAt: r.expires_at.getTime(),
});

export function createPgOwnershipLease(config: PgOwnershipLeaseConfig): OwnershipLease {
  const ttlMs = config.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const ttl = `${Math.round(ttlMs)} milliseconds`;
  const pool = new Pool({ connectionString: config.dsn, max: 4, connectionTimeoutMillis: 5000 });
  pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[ownershipLease] idle pg client error (non-fatal):", err.message);
  });

  let ensured: Promise<void> | undefined;
  const ensureTable = (): Promise<void> => {
    ensured ??= pool
      .query(
        `CREATE TABLE IF NOT EXISTS conversation_shard (
           conversation_id text PRIMARY KEY,
           owner_ord       int    NOT NULL,
           generation      bigint NOT NULL DEFAULT 0,
           expires_at      timestamptz NOT NULL
         )`,
      )
      .then(() => undefined)
      .catch((e) => {
        ensured = undefined; // retry next call
        throw e;
      });
    return ensured;
  };

  return {
    async acquire(conversationId, ownerOrd) {
      await ensureTable();
      // Grant iff: new row, OR the existing lease is expired, OR the same owner
      // re-acquires. Bump generation. The WHERE on the DO UPDATE is what fences a
      // live lease held by ANOTHER shard (no row updated -> RETURNING empty).
      const res = await pool.query<Row>(
        `INSERT INTO conversation_shard (conversation_id, owner_ord, generation, expires_at)
           VALUES ($1, $2, 1, now() + $3::interval)
         ON CONFLICT (conversation_id) DO UPDATE
           SET owner_ord  = EXCLUDED.owner_ord,
               generation = conversation_shard.generation + 1,
               expires_at = now() + $3::interval
           WHERE conversation_shard.expires_at <= now()
              OR conversation_shard.owner_ord = EXCLUDED.owner_ord
         RETURNING conversation_id, owner_ord, generation, expires_at`,
        [conversationId, ownerOrd, ttl],
      );
      return res.rows[0] ? rowToLease(res.rows[0]) : null;
    },

    async renew(conversationId, ownerOrd, generation) {
      await ensureTable();
      const res = await pool.query<Row>(
        `UPDATE conversation_shard
            SET expires_at = now() + $4::interval
          WHERE conversation_id = $1 AND owner_ord = $2 AND generation = $3
            AND expires_at > now()
         RETURNING conversation_id, owner_ord, generation, expires_at`,
        [conversationId, ownerOrd, generation, ttl],
      );
      return res.rows[0] ? rowToLease(res.rows[0]) : null;
    },

    async holds(conversationId, ownerOrd, generation) {
      await ensureTable();
      const res = await pool.query(
        `SELECT 1 FROM conversation_shard
          WHERE conversation_id = $1 AND owner_ord = $2 AND generation = $3
            AND expires_at > now()`,
        [conversationId, ownerOrd, generation],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async steal(conversationId, newOwnerOrd) {
      await ensureTable();
      // Unconditional (re)acquire, bumping generation -> fences the previous owner.
      const res = await pool.query<Row>(
        `INSERT INTO conversation_shard (conversation_id, owner_ord, generation, expires_at)
           VALUES ($1, $2, 1, now() + $3::interval)
         ON CONFLICT (conversation_id) DO UPDATE
           SET owner_ord  = EXCLUDED.owner_ord,
               generation = conversation_shard.generation + 1,
               expires_at = now() + $3::interval
         RETURNING conversation_id, owner_ord, generation, expires_at`,
        [conversationId, newOwnerOrd, ttl],
      );
      return rowToLease(res.rows[0]);
    },

    async release(conversationId, ownerOrd, generation) {
      await ensureTable();
      await pool.query(
        `DELETE FROM conversation_shard
          WHERE conversation_id = $1 AND owner_ord = $2 AND generation = $3`,
        [conversationId, ownerOrd, generation],
      );
    },

    async close() {
      await pool.end().catch(() => {});
    },
  };
}
