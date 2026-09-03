#!/usr/bin/env node
/**
 * One-shot CLI: run the mirror→Postgres event backfill.
 *
 * Invoked by the agent-event-backfill Job (modules/event-backfill.nix), which
 * mounts the history mirror read-only and provides the Postgres DSN. Run once
 * during the cutover, with `historyMirror.retainForMigration = true` so the PVC
 * outlives the cutover and the backfill can read history out of it.
 *
 * Usage:
 *   node dist/scripts/runEventBackfill.js <mirror-root-path>
 *
 * Exits 0 only if EVERY conversation verified (rows == lines, chain matches).
 * A partial success (127 of 128) exits 1 and the Job fails, because the mirror
 * is reclaimed after this runs and destroying history is the failure we prevent.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { backfillAll } from "../session/eventBackfill.js";
import { logger } from "../log.js";

const log = logger("runEventBackfill");

async function main() {
  const mirrorRoot = process.argv[2];
  if (!mirrorRoot) {
    console.error("Usage: node runEventBackfill.js <mirror-root-path>");
    process.exit(2);
  }

  const dsn = process.env.DATABASE_URL;
  if (!dsn) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(2);
  }

  log.info("starting event backfill", { mirrorRoot, dsn: dsn.replace(/:[^:@]+@/, ":***@") });

  const pool = new pg.Pool({ connectionString: dsn });
  const db = drizzle(pool);

  try {
    const report = await backfillAll(db, mirrorRoot);

    // Log the full report for operator review
    console.log("\n=== BACKFILL REPORT ===");
    console.log(JSON.stringify(report, null, 2));
    console.log("=======================\n");

    if (report.ok) {
      log.info("backfill SUCCESS — all conversations verified", {
        total: report.conversations.length,
        totalEvents: report.conversations.reduce((n, c) => n + c.rows, 0),
      });
      process.exit(0);
    } else {
      const failed = report.conversations.filter((c) => !c.ok);
      log.error("backfill FAILED — some conversations did not verify", {
        total: report.conversations.length,
        failed: failed.length,
        failedConversations: failed.map((c) => c.conversationId),
      });
      process.exit(1);
    }
  } catch (e) {
    log.error("backfill crashed", { error: e });
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
