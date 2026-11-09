/**
 * Identity store: an optional id-to-email enrichment layer over any IdentityResolver,
 * for ingresses that give a stable id but not always an email. It writes through
 * (whenever the resolver yields an email for an id, the mapping is upserted into
 * Postgres) and fills in (an id without an email is looked up in a deployer-seeded
 * static map, then the learned table). A DB error is logged and skipped, never
 * thrown into the request path.
 */

import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { webhooks } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";
import { normalizeEmail } from "./email.js";

import type { AsyncIdentityResolver, UserContext } from "./identity.js";

const { userIdentity } = webhooks;

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
  /** ISO timestamp this user was last seen (updated_at), to within an hour. */
  updatedAt?: string;
}

/** The persistence seam; Postgres below, a fake in tests. */
export interface IdentityStore {
  /** The learned record for an id, or undefined if unknown or on any error. */
  get(id: string): Promise<IdentityRecord | undefined>;
  /** Upsert the learned mapping, swallowing errors. */
  put(id: string, rec: IdentityRecord): Promise<void>;
  /** Reverse lookup: the most recently seen Scooter user id for an email (case-insensitive), or undefined. */
  getByEmail(email: string): Promise<{ id: string } | undefined>;
  /** List the learned users most-recently-seen first, capped at `limit`, or [] on any error. */
  list(limit?: number): Promise<UserRecord[]>;
  close(): Promise<void>;
}

export interface EnrichOptions {
  /** Learned-mapping store. */
  store?: IdentityStore;
  /** Deployer-seeded static id-to-email map, checked before the store. */
  staticMap?: Record<string, string>;
}

/** Wrap `resolver` so its UserContext is enriched with an email when it has none and successful (id, email) pairs are learned; anonymous requests pass straight through. */
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
        // Learn it; a write failure must not block the request.
        if (store) void store.put(user.id, { email: user.email, name: user.name });
        return user;
      }

      // No email from the ingress, so fill from the static map, then the store.
      const mapped = staticMap?.[user.id];
      if (mapped) return { ...user, email: mapped };
      if (store) {
        // A store that throws degrades to "no email".
        const rec = await store.get(user.id).catch(() => undefined);
        if (rec?.email) return { ...user, email: rec.email, name: user.name ?? rec.name };
      }
      return user;
    },
  };
}

// --- Postgres-backed store -------------------------------------------------

/** Max age of updated_at before an unchanged sighting refreshes it. */
const LAST_SEEN_RESOLUTION_MS = 60 * 60 * 1000;

export interface PgIdentityStoreConfig {
  /** Postgres connection string. */
  dsn: string;
}

/**
 * Postgres IdentityStore over the webhooks.user_identity table, declared in
 * lib/sql/webhooks/schema.sql and provisioned by the migrate job. All errors are
 * swallowed: a DB blip degrades to "no learned email" and never breaks a request.
 */
export function createPgIdentityStore(config: PgIdentityStoreConfig): IdentityStore {
  // The hardened pool (db/pgPool.ts) never hands a stale idle connection to a query.
  const pool = createPgPool("identityStore", { connectionString: config.dsn, max: 2 });
  const db = drizzle(pool);
  // Last write per id, so repeat sightings skip the database.
  const written = new Map<string, { email: string | null; name: string | null; at: number }>();

  return {
    async get(id) {
      try {
        const rows = await db
          .select({ email: userIdentity.email, name: userIdentity.name })
          .from(userIdentity)
          .where(eq(userIdentity.id, id))
          .limit(1);
        const row = rows[0];
        if (!row) return undefined;
        return { email: row.email ?? undefined, name: row.name ?? undefined };
      } catch (e) {
        log.error("get failed (no learned email)", { user_id: id, error: formatError(e) });
        return undefined;
      }
    },
    async put(id, rec) {
      try {
        // Store the normalized email so one mailbox is one value whatever form a provider
        // handed us; blank becomes null.
        const email = rec.email ? normalizeEmail(rec.email) || null : null;
        const name = rec.name ?? null;
        const now = Date.now();
        const last = written.get(id);
        if (last && last.email === email && last.name === name && now - last.at < LAST_SEEN_RESOLUTION_MS) return;
        // COALESCE(excluded, existing) so a later sighting without an email/name keeps
        // the value already learned.
        const nextEmail = sql`coalesce(excluded.email, ${userIdentity.email})`;
        const nextName = sql`coalesce(excluded.name, ${userIdentity.name})`;
        await db
          .insert(userIdentity)
          .values({ id, email, name, updatedAt: sql`now()` })
          .onConflictDoUpdate({
            target: userIdentity.id,
            set: { email: nextEmail, name: nextName, updatedAt: sql`now()` },
            // Rewrite an unchanged row only to refresh stale last-seen.
            setWhere: sql`${userIdentity.email} IS DISTINCT FROM ${nextEmail}
              OR ${userIdentity.name} IS DISTINCT FROM ${nextName}
              OR ${userIdentity.updatedAt} < now() - ${`${LAST_SEEN_RESOLUTION_MS} milliseconds`}::interval`,
          });
        written.set(id, { email, name, at: now });
      } catch (e) {
        log.error("put failed (mapping not learned)", { user_id: id, error: formatError(e) });
      }
    },
    async getByEmail(email) {
      // Match against the same normalization the store writes.
      const e = normalizeEmail(email);
      if (!e) return undefined;
      try {
        // The lower() also covers rows written before normalization; most recently updated wins if shared.
        const rows = await db
          .select({ id: userIdentity.id })
          .from(userIdentity)
          .where(sql`lower(${userIdentity.email}) = lower(${e})`)
          .orderBy(desc(userIdentity.updatedAt))
          .limit(1);
        const row = rows[0];
        return row ? { id: row.id } : undefined;
      } catch (err) {
        log.error("getByEmail failed (no match)", { error: formatError(err) });
        return undefined;
      }
    },
    async list(limit = 500) {
      try {
        const rows = await db
          .select({
            id: userIdentity.id,
            email: userIdentity.email,
            name: userIdentity.name,
            updatedAt: userIdentity.updatedAt,
          })
          .from(userIdentity)
          .orderBy(desc(userIdentity.updatedAt))
          .limit(limit);
        return rows.map((row) => ({
          id: row.id,
          email: row.email ?? undefined,
          name: row.name ?? undefined,
          updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : undefined,
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
