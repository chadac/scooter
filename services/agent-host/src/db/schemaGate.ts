/**
 * Startup gate between agent-host's code and the agent_host database schema.
 *
 * The agent-db-migrate Job applies lib/sql/agent_host/migrations. If it did not run
 * (failed, image not pullable, not yet finished), a new build starts against an older
 * schema and its first query fails with "column ... does not exist". That is not a
 * transient condition, so it must not be retried like a cold database, and the operator
 * needs to be pointed at the migration Job rather than at "hydrate failed".
 */

/**
 * The newest lib/sql/agent_host migration this build's queries depend on. A contract test
 * (schemaGate.spec.ts) fails when a newer migration is added without bumping this.
 */
export const EXPECTED_AGENT_HOST_SCHEMA_VERSION = "20261110154224";

/** Postgres SQLSTATEs meaning the schema lacks something the code references. */
const SCHEMA_MISMATCH_CODES = new Set([
  "42703", // undefined_column
  "42P01", // undefined_table
]);

const MIGRATE_HINT =
  "the agent_host database schema is older than this build; check that the agent-db-migrate Job ran and succeeded for this release";

/** Thrown when the database is provably behind the code; never worth retrying. */
export class SchemaMismatchError extends Error {
  readonly hint = MIGRATE_HINT;
  constructor(
    message: string,
    readonly detail: { dbVersion?: string | null; expectedVersion?: string; sqlState?: string },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SchemaMismatchError";
  }
}

function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** True when `err` means the schema is older than the code (not a slow or absent DB). */
export function isSchemaMismatch(err: unknown): boolean {
  if (err instanceof SchemaMismatchError) return true;
  const code = sqlState(err);
  return code !== undefined && SCHEMA_MISMATCH_CODES.has(code);
}

/** Wrap a raw Postgres undefined-column/table error so it carries the migration hint. */
export function asSchemaMismatch(err: unknown): SchemaMismatchError {
  if (err instanceof SchemaMismatchError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new SchemaMismatchError(`${MIGRATE_HINT} (${msg})`, { sqlState: sqlState(err) }, { cause: err });
}

/** Minimal query surface (a pg Pool or Client satisfies it). */
export interface Queryable {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type SchemaCheck =
  | { status: "ok"; dbVersion: string }
  | { status: "unmanaged" }; // no Atlas revisions table: a dev DB built from schema.sql

/**
 * Compare the newest fully applied Atlas revision with `expected`. Resolves when the
 * database is at or ahead of the code (ahead is normal mid-rollout, when old pods still
 * run against freshly migrated tables); throws SchemaMismatchError when it is behind.
 * Connection errors propagate unchanged so the caller can retry them.
 */
export async function checkSchemaVersion(
  db: Queryable,
  expected: string = EXPECTED_AGENT_HOST_SCHEMA_VERSION,
): Promise<SchemaCheck> {
  let rows: Array<Record<string, unknown>>;
  try {
    ({ rows } = await db.query(
      "SELECT max(version) AS version FROM atlas_schema_revisions.atlas_schema_revisions WHERE applied >= total",
    ));
  } catch (err) {
    // The revisions table itself is missing: Atlas never ran here.
    if (sqlState(err) === "42P01" || sqlState(err) === "3F000") return { status: "unmanaged" };
    throw err;
  }
  const dbVersion = (rows[0]?.version as string | null | undefined) ?? null;
  // Versions are fixed-width timestamps, so string order is version order.
  if (dbVersion === null || dbVersion < expected) {
    throw new SchemaMismatchError(
      `${MIGRATE_HINT}: database is at migration ${dbVersion ?? "(none)"}, this build needs ${expected}`,
      { dbVersion, expectedVersion: expected },
    );
  }
  return { status: "ok", dbVersion };
}
