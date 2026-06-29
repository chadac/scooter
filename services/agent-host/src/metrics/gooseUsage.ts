/**
 * Reads per-session token usage from goose's local session store.
 *
 * goose (>= 1.10) persists sessions to a SQLite DB under its $HOME:
 *   $HOME/.local/share/goose/sessions/sessions.db
 * containing token-usage statistics per session. goose does NOT report usage
 * over ACP (the PromptResponse carries only stopReason — goose issue #8132), so
 * reading this DB out-of-band is the only token source available today.
 *
 * IMPORTANT robustness notes (this couples us to goose's schema, which is
 * undocumented and may change across versions):
 *   - The reader INTROSPECTS the DB (table/column discovery) rather than
 *     hard-coding a schema, and returns `undefined` if it can't find usage —
 *     metrics then simply omit cost for that run (graceful degradation).
 *   - goose's $HOME is on an emptyDir in our deployment, so the DB is ephemeral.
 *     We read usage PER-RUN (right after RUN_FINISHED) and emit immediately; we
 *     never rely on it for history.
 *
 * DESIGN STAGE: signatures + types only. No implementation.
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import type { TokenUsage } from "./pricing.js";
import { debug, debugError } from "../debug.js";

/** goose's session DB, relative to its $HOME. */
const DB_RELATIVE = [".local", "share", "goose", "sessions", "sessions.db"];

/** Token columns we look for, in preference order (accumulated = cumulative per
 *  session, which is what we want to diff per-run; fall back to the per-turn
 *  columns if a goose version lacks the accumulated ones). */
const COLS = {
  input: ["accumulated_input_tokens", "input_tokens"],
  output: ["accumulated_output_tokens", "output_tokens"],
  cacheRead: ["accumulated_cache_read_tokens", "cache_read_tokens"],
  cacheWrite: ["accumulated_cache_write_tokens", "cache_write_tokens"],
  total: ["accumulated_total_tokens", "total_tokens"],
} as const;

export interface GooseUsageReaderConfig {
  /** goose's $HOME (the agent-host's HOME). The DB is resolved relative to it. */
  gooseHome: string;
}

export interface GooseUsageReader {
  /**
   * Best-effort cumulative token usage for an ACP session id, as currently
   * recorded in goose's session DB. Returns `undefined` if the DB/columns/row
   * aren't found (so the caller omits cost rather than reporting a false 0).
   *
   * Callers compute a PER-RUN delta by diffing successive reads for a session
   * (this returns the cumulative total; the metrics layer keeps the last value).
   */
  readSessionUsage(acpSessionId: string): Promise<TokenUsage | undefined>;

  /** Close any open DB handle. */
  close(): Promise<void>;
}

/**
 * Open a reader over goose's session DB. Does not throw if the DB is absent
 * (readSessionUsage will return undefined) — a deployment without the expected
 * goose layout still runs, just without cost metrics.
 */
export function createGooseUsageReader(config: GooseUsageReaderConfig): GooseUsageReader {
  const dbPath = join(config.gooseHome, ...DB_RELATIVE);

  // The DB is opened lazily on first read (goose creates it on its first run, so
  // it may not exist when the reader is constructed). We re-resolve the column
  // set each open since a goose upgrade could change the schema under us.
  let db: DatabaseSync | undefined;
  let available: { table: string; cols: Partial<Record<keyof typeof COLS, string>> } | undefined;
  let openedOnce = false;

  /** Discover the first present column from a candidate list. */
  const pick = (have: Set<string>, candidates: readonly string[]): string | undefined =>
    candidates.find((c) => have.has(c));

  const open = (): boolean => {
    if (openedOnce) return db !== undefined && available !== undefined;
    openedOnce = true;
    try {
      // readonly so we never contend with goose's writer; open() throws if absent.
      db = new DatabaseSync(dbPath, { readOnly: true });
      // goose stores sessions in the `sessions` table keyed by id. Confirm the
      // table + the token columns exist (introspection, so a schema change
      // degrades to "no cost" rather than a crash).
      const cols = new Set(
        (db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      );
      const resolved = {
        input: pick(cols, COLS.input),
        output: pick(cols, COLS.output),
        cacheRead: pick(cols, COLS.cacheRead),
        cacheWrite: pick(cols, COLS.cacheWrite),
        total: pick(cols, COLS.total),
      };
      // Need at least input or total to report anything meaningful.
      if (!resolved.input && !resolved.total) {
        debug("[metrics] goose sessions.db has no token columns; cost disabled");
        return false;
      }
      available = { table: "sessions", cols: resolved };
      return true;
    } catch (err) {
      debug("[metrics] goose sessions.db not readable (%s); cost will be omitted", dbPath);
      return false;
    }
  };

  return {
    async readSessionUsage(acpSessionId: string): Promise<TokenUsage | undefined> {
      if (!open() || !db || !available) return undefined;
      const { cols } = available;
      // Build a SELECT of just the columns we found.
      const select: Array<[keyof TokenUsage, string]> = [];
      if (cols.input) select.push(["inputTokens", cols.input]);
      if (cols.output) select.push(["outputTokens", cols.output]);
      if (cols.cacheRead) select.push(["cachedReadTokens", cols.cacheRead]);
      if (cols.cacheWrite) select.push(["cachedWriteTokens", cols.cacheWrite]);
      if (cols.total) select.push(["totalTokens", cols.total]);
      try {
        const sql = `SELECT ${select.map(([, c]) => `"${c}" AS "${c}"`).join(", ")} FROM sessions WHERE id = ? LIMIT 1`;
        const row = db.prepare(sql).get(acpSessionId) as Record<string, number | null> | undefined;
        if (!row) return undefined; // unknown session -> no false 0
        const usage: TokenUsage = {};
        for (const [field, col] of select) {
          const v = row[col];
          if (typeof v === "number") usage[field] = v;
        }
        return usage;
      } catch (err) {
        debugError("[metrics] goose usage read failed:", err);
        return undefined;
      }
    },

    async close(): Promise<void> {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      db = undefined;
    },
  };
}
