/**
 * Identity store — a GENERIC, optional sub→email enrichment layer over ANY
 * IdentityResolver (not ALB-specific).
 *
 * Some ingresses give a stable id but not an email on every request (e.g. an ALB
 * whose x-amzn-oidc-data JWT lacks the email claim on a given call, or a proxy
 * that only forwards a `sub`). This decorator:
 *   - WRITES THROUGH: whenever the resolver yields an email for an id, upsert
 *     (id → email/name) into a small Postgres table, so we learn the mapping.
 *   - FILLS IN: when the resolver yields an id WITHOUT an email, look it up —
 *     first a static config map (deployer-seeded), then the learned Postgres
 *     cache. If still unknown, the id (sub) stands on its own.
 *
 * Best-effort and non-blocking-critical: a DB error is logged and skipped, never
 * throws into the request path. Entirely optional — with neither a store nor a
 * map wired, this is a passthrough.
 */

import { Pool } from "pg";

import type { IdentityResolver, UserContext } from "./identity.js";

export interface IdentityRecord {
  email?: string;
  name?: string;
}

/** The persistence seam (Postgres impl below; tests inject a fake). */
export interface IdentityStore {
  /** The learned record for an id, or undefined if unknown / on any error. */
  get(id: string): Promise<IdentityRecord | undefined>;
  /** Upsert the learned mapping (best-effort; errors swallowed). */
  put(id: string, rec: IdentityRecord): Promise<void>;
  close(): Promise<void>;
}

export interface EnrichOptions {
  /** Learned-mapping store (optional). */
  store?: IdentityStore;
  /** Deployer-seeded static map: id → email. Checked before the store. */
  staticMap?: Record<string, string>;
}

/**
 * Wrap `resolver` so its UserContext is enriched with an email when the resolver
 * didn't provide one, and successful (id,email) pairs are learned. Returns a
 * resolver whose resolve() is ASYNC (the store lookup). Anonymous requests pass
 * straight through (no id to enrich or persist).
 */
export function withIdentityStore(
  resolver: IdentityResolver,
  opts: EnrichOptions = {},
): { resolve(req: import("node:http").IncomingMessage): Promise<UserContext> } {
  const { store, staticMap } = opts;
  return {
    async resolve(req) {
      const user = resolver.resolve(req);
      if (user.anonymous) return user;

      if (user.email) {
        // Learn it (fire-and-forget; a write failure must not block the request).
        if (store) void store.put(user.id, { email: user.email, name: user.name });
        return user;
      }

      // No email from the ingress — fill from the static map, then the store.
      const mapped = staticMap?.[user.id];
      if (mapped) return { ...user, email: mapped };
      if (store) {
        // Guard the lookup: a store that throws must degrade to "no email", never
        // break the request path.
        const rec = await store.get(user.id).catch(() => undefined);
        if (rec?.email) return { ...user, email: rec.email, name: user.name ?? rec.name };
      }
      return user;
    },
  };
}

// --- Postgres-backed store -------------------------------------------------

export interface PgIdentityStoreConfig {
  /** Postgres connection string. */
  dsn: string;
}

/**
 * Postgres IdentityStore over a `user_identity(id, email, name, updated_at)` table
 * on the shared DB. Lazy pool; CREATE TABLE IF NOT EXISTS on first use so no
 * migration is required. All errors are swallowed (best-effort) — a DB blip
 * degrades to "no learned email", never breaks a request.
 */
export function createPgIdentityStore(config: PgIdentityStoreConfig): IdentityStore {
  const pool = new Pool({ connectionString: config.dsn, max: 2, connectionTimeoutMillis: 5000 });
  pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[identityStore] idle pg client error (non-fatal):", err.message);
  });

  let ensured: Promise<void> | undefined;
  const ensureTable = (): Promise<void> => {
    ensured ??= pool
      .query(
        `CREATE TABLE IF NOT EXISTS user_identity (
           id text PRIMARY KEY,
           email text,
           name text,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined)
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[identityStore] ensure table failed (identity enrichment off):", (e as Error).message);
        ensured = undefined; // allow a retry on the next call
      });
    return ensured;
  };

  return {
    async get(id) {
      try {
        await ensureTable();
        const res = await pool.query(`SELECT email, name FROM user_identity WHERE id = $1 LIMIT 1`, [id]);
        const row = res.rows[0];
        if (!row) return undefined;
        return { email: row.email ?? undefined, name: row.name ?? undefined };
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[identityStore] get(${id}) failed (no learned email):`, (e as Error).message);
        return undefined;
      }
    },
    async put(id, rec) {
      try {
        await ensureTable();
        await pool.query(
          `INSERT INTO user_identity (id, email, name, updated_at)
             VALUES ($1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET
             email = COALESCE(EXCLUDED.email, user_identity.email),
             name = COALESCE(EXCLUDED.name, user_identity.name),
             updated_at = now()`,
          [id, rec.email ?? null, rec.name ?? null],
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[identityStore] put(${id}) failed (mapping not learned):`, (e as Error).message);
      }
    },
    async close() {
      await pool.end().catch(() => {});
    },
  };
}
