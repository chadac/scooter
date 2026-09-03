/**
 * Tier 1 contract — the one-shot mirror→Postgres backfill.
 *
 * The Job runs once and the mirror volume is reclaimed afterwards, so a
 * backfill that loads 127 of 128 conversations and exits 0 destroys history.
 * These tests are mostly about the VERIFY half, not the load half.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";

import { backfillAll, parseLog, expectedChain, countSeams } from "../../src/session/eventBackfill.js";
import { chainNext, EMPTY_CHECKSUM } from "../../src/agui/integrity.js";
import type { AguiEvent } from "../../src/bridge.js";

const ev = (n: number, ts?: number): AguiEvent =>
  ({ type: "TEXT_MESSAGE_CONTENT", messageId: `m${n}`, delta: `d${n}`, ...(ts ? { ts } : {}) }) as AguiEvent;

/** A mirror tree: { convId: [lines] }. */
function mirror(tree: Record<string, string[]>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mirror-"));
  for (const [id, lines] of Object.entries(tree)) {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "events.jsonl"), lines.join("\n") + "\n");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  const client = {
    async query(cfg: { text: string } | string, params: unknown[] = []) {
      const text = typeof cfg === "string" ? cfg : cfg.text;
      const values = ((typeof cfg === "string" ? params : params) ?? []) as unknown[];
      if (text.trim().toUpperCase().startsWith("INSERT")) {
        rows.push({ conversation_id: values[0], seq: values[1], event: values[2] });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { db: drizzle(client as never), rows };
}

describe("eventBackfill — verification", () => {
  it("reports ok when every conversation loads with a matching chain", async () => {
    const lines = [ev(1), ev(2)].map((e) => JSON.stringify(e));
    const m = mirror({ "conv-a": lines, "conv-b": lines });
    try {
      const { db } = fakeDb();
      const report = await backfillAll(db, m.root);
      expect(report.ok).toBe(true);
      expect(report.conversations).toHaveLength(2);
      expect(report.conversations.every((c) => c.rows === 2)).toBe(true);
    } finally {
      m.cleanup();
    }
  });

  it("THE FAILURE THIS PREVENTS: one bad conversation makes the WHOLE report not-ok", async () => {
    // 127 of 128 loading must never look like success — the mirror is deleted
    // after this runs.
    const good = [ev(1)].map((e) => JSON.stringify(e));
    const m = mirror({ "conv-good": good, "conv-bad": ["{not json"] });
    try {
      const { db } = fakeDb();
      const report = await backfillAll(db, m.root);
      expect(report.ok, "a single failure must fail the run").toBe(false);
      expect(report.conversations.find((c) => c.conversationId === "conv-bad")?.ok).toBe(false);
      // ...and the good one is still reported as loaded, so an operator can see scope.
      expect(report.conversations.find((c) => c.conversationId === "conv-good")?.ok).toBe(true);
    } finally {
      m.cleanup();
    }
  });

  it("a conversation directory with NO log is a failure, not a skip", async () => {
    // The mirror having a conversation we cannot migrate must be visible before
    // the volume is reclaimed.
    const m = mirror({ "conv-a": [JSON.stringify(ev(1))] });
    mkdirSync(join(m.root, "conv-empty"), { recursive: true });
    try {
      const { db } = fakeDb();
      const report = await backfillAll(db, m.root);
      expect(report.ok).toBe(false);
      expect(report.conversations.find((c) => c.conversationId === "conv-empty")?.error).toBeTruthy();
    } finally {
      m.cleanup();
    }
  });

  it("A CORRUPTED LOAD is caught: right row count, WRONG chain", async () => {
    // The row-count check alone would pass this. Only comparing the chain
    // catches a load that wrote the right NUMBER of rows from the wrong bytes —
    // and after the mirror is reclaimed there is nothing left to compare against.
    const lines = [ev(1), ev(2)].map((e) => JSON.stringify(e));
    const m = mirror({ "conv-a": lines });
    try {
      const { db } = fakeDb();
      // A store whose chain drifts: same row count, different checksum.
      const store = await import("../../src/session/eventStore.js");
      const spy = vi
        .spyOn(store, "backfillConversation")
        .mockResolvedValue({ conversationId: "conv-a" as never, rows: 2, finalChecksum: "deadbeef" });
      const report = await backfillAll(db, m.root);
      spy.mockRestore();

      expect(report.ok, "a checksum mismatch must fail the run").toBe(false);
      const c = report.conversations[0];
      expect(c.rows).toBe(c.lines); // count agreed...
      expect(c.actualChecksum).not.toBe(c.expectedChecksum); // ...the chain did not
    } finally {
      m.cleanup();
    }
  });

  it("the expected chain is computed from the FILE, independently of the writer", async () => {
    // Otherwise the check is circular: the backfill would be verifying itself.
    const events = [ev(1), ev(2), ev(3)];
    let acc = EMPTY_CHECKSUM;
    for (const e of events) acc = chainNext(acc, e);
    expect(expectedChain(events)).toBe(acc);
  });
});

describe("eventBackfill — restart seams", () => {
  it("COUNTS seams rather than silently reordering", async () => {
    // A seam means ts goes backwards: the file store rendered these in ts order,
    // Postgres renders them in append order. That cost must be visible.
    const seamed = [ev(1, 100), ev(2, 300), ev(3, 200)].map((e) => JSON.stringify(e));
    const m = mirror({ "conv-seam": seamed });
    try {
      const { db } = fakeDb();
      const report = await backfillAll(db, m.root);
      expect(report.conversations[0].seams).toBe(1);
      expect(report.ok, "a seam is reported, NOT a failure").toBe(true);
    } finally {
      m.cleanup();
    }
  });

  it("a log with no seams reports zero", async () => {
    expect(countSeams([ev(1, 100), ev(2, 200), ev(3, 300)])).toBe(0);
  });

  it("events without ts never count as a seam", async () => {
    expect(countSeams([ev(1), ev(2), ev(3)])).toBe(0);
  });
});

describe("eventBackfill — parsing", () => {
  it("skips blank lines", () => {
    expect(parseLog(`${JSON.stringify(ev(1))}\n\n${JSON.stringify(ev(2))}\n`)).toHaveLength(2);
  });

  it("a malformed line THROWS with its line number, rather than loading partially", () => {
    expect(() => parseLog(`${JSON.stringify(ev(1))}\n{oops\n`)).toThrow(/line 2/);
  });
});
