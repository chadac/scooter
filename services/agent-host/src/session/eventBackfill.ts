/**
 * One-shot backfill: conversation event logs from the NFS mirror into Postgres.
 *
 * Runs ONCE before the cutover, from a Job that mounts the mirror read-only.
 * The mirror is the only copy of any history Postgres does not have yet, so
 * `historyMirror.retainForMigration` must be true until this has reported every
 * conversation loaded — see modules/conversation-controller.nix.
 *
 * VERIFIES rather than assumes. A backfill that loads 127 of 128 conversations
 * and exits 0 is the failure this is written to prevent (see the agent_host
 * empty-database incident: a migrator that skipped a database and still printed
 * "all migrations applied").
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { chainNext, EMPTY_CHECKSUM } from "../agui/integrity.js";
import { formatError, logger } from "../log.js";
import { backfillConversation } from "./eventStore.js";
import type { AguiEvent } from "../bridge.js";
import type { SessionId } from "../types.js";

const log = logger("eventBackfill");

export interface ConversationReport {
  conversationId: string;
  /** Lines in the file (non-empty). */
  lines: number;
  /** Rows the backfill wrote. Must equal `lines`. */
  rows: number;
  /** Chain recomputed from the FILE, independently of the writer. */
  expectedChecksum: string;
  /** Chain the backfill reported. Must equal `expectedChecksum`. */
  actualChecksum: string;
  /**
   * Events whose `ts` precedes their predecessor's — a restart seam. The file
   * store rendered these in ts order; Postgres renders them in append order.
   * Reported rather than silently reordered, so the cost is visible.
   */
  seams: number;
  ok: boolean;
  error?: string;
}

export interface BackfillReport {
  conversations: ConversationReport[];
  /** True only if EVERY conversation verified. The Job's exit code. */
  ok: boolean;
}

/** Parse a log, skipping blank lines. Throws on a malformed line — a log we
 *  cannot parse must fail loudly, not load partially. */
export function parseLog(data: string): AguiEvent[] {
  return data
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as AguiEvent;
      } catch (e) {
        throw new Error(`line ${i + 1}: ${JSON.stringify(formatError(e))}`);
      }
    });
}

/** Chain recomputed from the file, independent of what the backfill wrote. */
export function expectedChain(events: AguiEvent[]): string {
  let acc = EMPTY_CHECKSUM;
  for (const e of events) acc = chainNext(acc, e);
  return acc;
}

/** Count restart seams: events whose ts goes backwards. */
export function countSeams(events: AguiEvent[]): number {
  let seams = 0;
  let last: number | undefined;
  for (const e of events) {
    const ts = (e as { ts?: number }).ts;
    if (typeof ts === "number") {
      if (last !== undefined && ts < last) seams++;
      last = ts;
    }
  }
  return seams;
}

/** Backfill every conversation under `mirrorRoot`, verifying each. */
export async function backfillAll(db: NodePgDatabase, mirrorRoot: string): Promise<BackfillReport> {
  const dirs = (await readdir(mirrorRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const conversations: ConversationReport[] = [];

  for (const id of dirs) {
    try {
      const data = await readFile(join(mirrorRoot, id, "events.jsonl"), "utf8");
      const events = parseLog(data);
      const lines = events.length;
      const expected = expectedChain(events);
      const seams = countSeams(events);
      const res = await backfillConversation(
        db,
        id as SessionId,
        data.split("\n").filter((l) => l.trim()),
      );
      const ok = res.rows === lines && res.finalChecksum === expected;
      conversations.push({
        conversationId: id,
        lines,
        rows: res.rows,
        expectedChecksum: expected,
        actualChecksum: res.finalChecksum,
        seams,
        ok,
      });
    } catch (e) {
      // ENOENT (a conversation dir with no log) is NOT ok — it means the
      // mirror has a conversation whose history we cannot migrate, and the
      // operator must see it before the volume is reclaimed.
      conversations.push({
        conversationId: id,
        lines: 0,
        rows: 0,
        expectedChecksum: "",
        actualChecksum: "",
        seams: 0,
        ok: false,
        error: JSON.stringify(formatError(e)),
      });
    }
  }

  const report: BackfillReport = { conversations, ok: conversations.every((c) => c.ok) };
  const seamed = conversations.filter((c) => c.seams > 0);
  log.info("backfill complete", {
    conversations: conversations.length,
    events: conversations.reduce((n, c) => n + c.rows, 0),
    failed: conversations.filter((c) => !c.ok).length,
    // Loud on purpose: these render in append order after the cutover, where
    // the file store rendered them in ts order.
    conversations_with_restart_seams: seamed.length,
    ok: report.ok,
  });
  for (const c of conversations.filter((x) => !x.ok)) {
    log.error("backfill FAILED for a conversation", {
      conversation_id: c.conversationId,
      lines: c.lines,
      rows: c.rows,
      checksum_matches: c.expectedChecksum === c.actualChecksum,
      error: c.error,
    });
  }
  return report;
}
