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

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";
import { normalizeEmail } from "./email.js";

import type { AsyncIdentityResolver, UserContext } from "./identity.js";

const log = logger("identityStore");

export interface IdentityRecord {
  email?: string;
  name?: string;
}

/** A learned user, as listed for the settings Users page. */
export interface UserRecord {
  id: string;
  email?: string;
  name?: string;
  /** ISO timestamp we last saw this user (updated_at). */
  updatedAt?: string;
}

/** The persistence seam (Postgres impl below; tests inject a fake). */
export interface IdentityStore {
  /** The learned record for an id, or undefined if unknown / on any error. */
  get(id: string): Promise<IdentityRecord | undefined>;
  /** Upsert the learned mapping (best-effort; errors swallowed). */
  put(id: string, rec: IdentityRecord): Promise<void>;
  /** Reverse lookup: the Scooter user id for an email (case-insensitive), or
   *  undefined if no user has that email / on any error. Powers the external-user
   *  identity mapping (a webhook resolves its invoking user's email → this id →
   *  the conversation owner). A row = a real Scooter user (every ingress login
   *  upserts one). If several rows share an email, returns the most recently seen. */
  getByEmail(email: string): Promise<{ id: string } | undefined>;
  /** List the learned users (most-recently-seen first), for the settings Users page.
   *  This is the set of users who've actually signed in or been mapped — a learned
   *  list, not a full roster. Returns [] on any error. `limit` caps the result. */
  list(limit?: number): Promise<UserRecord[]>;
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
  resolver: AsyncIdentityResolver,
  opts: EnrichOptions = {},
): { resolve(req: import("node:http").IncomingMessage): Promise<UserContext> } {
  const { store, staticMap } = opts;
  return {
    async resolve(req) {
      const user = await resolver.resolve(req);
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
  // Hardened pool (idleTimeoutMillis + keepAlive) so a stale idle connection is
  // never handed to a query — this store's put() runs on every request, and a
  // 5s stall on a dead connection previously pushed /healthz past the readiness
  // probe and took the whole UI down. See db/pgPool.ts.
  const pool = createPgPool("identityStore", { connectionString: config.dsn, max: 2 });

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
      // A case-insensitive email index so the reverse lookup (getByEmail) is a
      // single indexed scan. Separate statement (IF NOT EXISTS, idempotent).
      .then(() =>
        pool.query(`CREATE INDEX IF NOT EXISTS user_identity_email_lower ON user_identity (lower(email))`),
      )
      .then(() => undefined)
      .catch((e) => {
        log.error("ensure table failed (identity enrichment off)", { error: formatError(e) });
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
        log.error("get failed (no learned email)", { user_id: id, error: formatError(e) });
        return undefined;
      }
    },
    async put(id, rec) {
      try {
        await ensureTable();
        // Store the NORMALIZED email (lowercase, trimmed, +tag dropped) so the same
        // mailbox is one value regardless of the cosmetic form a provider handed us —
        // getByEmail matches against the same normalization. A blank/absent email → null.
        const email = rec.email ? normalizeEmail(rec.email) || null : null;
        await pool.query(
          `INSERT INTO user_identity (id, email, name, updated_at)
             VALUES ($1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET
             email = COALESCE(EXCLUDED.email, user_identity.email),
             name = COALESCE(EXCLUDED.name, user_identity.name),
             updated_at = now()`,
          [id, email, rec.name ?? null],
        );
      } catch (e) {
        log.error("put failed (mapping not learned)", { user_id: id, error: formatError(e) });
      }
    },
    async getByEmail(email) {
      // Match against the SAME normalization we store (lowercase, trimmed, +tag
      // dropped) so alice+work@Example.com resolves to the same user as alice@example.com.
      const e = normalizeEmail(email);
      if (!e) return undefined;
      try {
        await ensureTable();
        // Emails are stored normalized; the lower() is belt-and-suspenders for any
        // legacy row written before normalization. Most-recently-updated wins if shared.
        const res = await pool.query(
          `SELECT id FROM user_identity WHERE lower(email) = lower($1) ORDER BY updated_at DESC LIMIT 1`,
          [e],
        );
        const row = res.rows[0];
        return row ? { id: row.id as string } : undefined;
      } catch (err) {
        log.error("getByEmail failed (no match)", { error: formatError(err) });
        return undefined;
      }
    },
    async list(limit = 500) {
      try {
        await ensureTable();
        const res = await pool.query(
          `SELECT id, email, name, updated_at FROM user_identity
             ORDER BY updated_at DESC LIMIT $1`,
          [limit],
        );
        return res.rows.map((row) => ({
          id: row.id as string,
          email: row.email ?? undefined,
          name: row.name ?? undefined,
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
        }));
      } catch (e) {
        log.error("list failed", { error: formatError(e) });
        return [];
      }
    },
    async close() {
      await pool.end().catch(() => {});
    },
  };
}
