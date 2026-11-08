/**
 * Which conversations wait on the user's answer, for the sidebar's "!". The table lives in
 * the database a contrib provides as `awaiting-input` (AWAITING_INPUT_DB_NAME), not in
 * agent_host, so there is no foreign key: removeConversation deletes the row itself. A
 * failed write is logged and rethrown for the caller to retry; the table's trigger tells
 * the router.
 */

import type { Pool } from "pg";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";
import type { SessionId } from "../types.js";

const log = logger("awaitingInput");

export interface AwaitingInputStore {
  /** Mark the conversation as waiting since `at`, or clear it (null); logs and throws when the write fails. */
  set(id: SessionId, at: number | null): Promise<void>;
  close(): Promise<void>;
}

export interface PgAwaitingInputStoreConfig {
  /** Postgres connection string, ignored when `pool` is supplied. */
  dsn?: string;
  /** Override of the pool for tests. */
  pool?: Pool;
}

export function createPgAwaitingInputStore(cfg: PgAwaitingInputStoreConfig): AwaitingInputStore {
  const pool = cfg.pool ?? createPgPool("awaitingInput", { connectionString: cfg.dsn ?? "", max: 2 });
  return {
    async set(id, at) {
      try {
        if (at === null) {
          await pool.query(`DELETE FROM conversation_awaiting_input WHERE conversation_id = $1`, [id]);
        } else {
          await pool.query(
            `INSERT INTO conversation_awaiting_input (conversation_id, since) VALUES ($1, $2)
             ON CONFLICT (conversation_id) DO UPDATE SET since = EXCLUDED.since`,
            [id, at],
          );
        }
      } catch (e) {
        log.error("awaiting-input write failed (sidebar question state not persisted)", {
          conversation_id: id,
          error: formatError(e),
        });
        throw e;
      }
    },
    async close() {
      if (!cfg.pool) await pool.end();
    },
  };
}
