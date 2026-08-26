/**
 * Shared node-postgres Pool factory with STALE-CONNECTION hardening.
 *
 * The bug this fixes: a plain `new Pool({ connectionString })` keeps idle
 * connections open indefinitely. After hours/days the DB (or a k8s / cloud network
 * path's idle reaper) silently drops an idle TCP connection, but the pool doesn't
 * know it's dead — so the NEXT `query()` on that connection hangs until
 * `connectionTimeoutMillis` fires ("Connection terminated due to connection
 * timeout"). Because the identity store's `put()` runs on EVERY request, a 5s stall
 * there pushed `/healthz` past the 1s readiness probe → the agent-host went NotReady
 * → the whole UI couldn't reach any conversation until the pod was restarted.
 *
 * The fix is two options:
 *   - idleTimeoutMillis: evict a connection that's been idle this long, so the pool
 *     never hands out a connection old enough to have been reaped. 30s is well under
 *     any reasonable server/network idle timeout.
 *   - keepAlive: enable TCP keepalive so an otherwise-idle connection stays alive
 *     (and a genuinely-dead one surfaces as a socket error the pool evicts, rather
 *     than a silent black hole).
 *
 * `max` and any extra options are per-caller; these defaults can be overridden.
 */

import { formatError, logger } from "../log.js";
import { Pool, type PoolConfig } from "pg";

export interface PgPoolOptions extends PoolConfig {
  /** The connection string (required). */
  connectionString: string;
}

/** Create a hardened pg Pool. `label` tags the non-fatal idle-error log. */
export function createPgPool(label: string, opts: PgPoolOptions): Pool {
  const pool = new Pool({
    // Fail fast if a fresh connect can't be established.
    connectionTimeoutMillis: 5000,
    // Never reuse a connection idle longer than this — the core stale-connection fix.
    idleTimeoutMillis: 30_000,
    // TCP keepalive: keep idle connections warm; surface dead ones as socket errors.
    keepAlive: true,
    ...opts,
  });
  // pg emits 'error' on the pool for backend/idle-client failures — log and continue
  // so a DB blip never crashes the process.
  pool.on("error", (err) => {
    logger(label).error("idle pg client error (non-fatal)", { error: formatError(err) });
  });
  return pool;
}
