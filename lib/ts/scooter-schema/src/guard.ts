/**
 * Runtime ownership guard. Each service connects to exactly one shared database
 * (the one it owns / co-owns); this asserts a client is actually pointed at that
 * database, so a mis-wired DSN fails fast at startup instead of writing into the
 * wrong database's tables. Pair it with the per-database table exports from this
 * package — a service should only import the database module(s) it may touch.
 *
 * NOT generated — hand-written and stable across `just db-generate`.
 */

/** The database names this package models — the atlas envs under lib/sql. */
export const DATABASES = ["webhooks", "scheduler", "broker", "byoc", "agent_host"] as const;
export type Database = (typeof DATABASES)[number];

/** Minimal shape of a node-postgres Pool/Client — just enough to run one query. */
export interface Queryable {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Assert `db` is connected to the `expected` database. Throws otherwise. Call it
 * once at startup (best-effort is fine: a wrong database is a deploy misconfig,
 * not a transient error, so failing loudly is correct).
 */
export async function assertDatabase(db: Queryable, expected: Database): Promise<void> {
  const res = await db.query("select current_database() as db");
  const actual = res.rows[0]?.db;
  if (actual !== expected) {
    throw new Error(
      `@scooter/schema: connected to database "${String(actual)}" but this client is for "${expected}" — refusing to run. A service must only use the database it owns (check its DSN's DB name).`,
    );
  }
}
