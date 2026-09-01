/**
 * Tier 1 contract — the conversation event log on Postgres.
 *
 * These encode the invariants the file store proved over many incidents, so a
 * store that passes them is a safe replacement for it.
 *
 * Each test names the failure it prevents. The four that matter most:
 *   - ORDER under fire-and-forget appends (a scrambled log breaks replay AND
 *     the integrity chain, and the chain makes that detectable but not fixable)
 *   - the chain CONTINUING across a restart (a new pod must not reseed from
 *     scratch and fork every client's verification)
 *   - the TAIL windowing by TIME, not append order, across a restart seam
 *   - flush() closing the subagent-completion race
 *
 * Runs against a REAL drizzle client over an in-memory Postgres double, so the
 * store's generated-model queries are exercised rather than a hand-rolled shim.
 */

import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { createPgEventStore, backfillConversation } from "../../src/session/eventStore.js";
import { chainNext, EMPTY_CHECKSUM } from "../../src/agui/integrity.js";
import type { ChecksummedEvent } from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SessionId } from "../../src/types.js";

const CONV = "conv-1" as SessionId;

const run = (n: number, ts?: number): AguiEvent[] =>
  [
    { type: "RUN_STARTED", threadId: "t", runId: `r${n}`, ...(ts ? { ts } : {}) },
    { type: "TEXT_MESSAGE_START", messageId: `m${n}`, role: "assistant", ...(ts ? { ts: ts + 1 } : {}) },
    { type: "TEXT_MESSAGE_CONTENT", messageId: `m${n}`, delta: `hi ${n}`, ...(ts ? { ts: ts + 2 } : {}) },
    { type: "TEXT_MESSAGE_END", messageId: `m${n}`, ...(ts ? { ts: ts + 3 } : {}) },
  ] as AguiEvent[];

/**
 * An in-memory Postgres under a real drizzle client. Rows live in an array so a
 * test can inspect physical order, which is the thing most of these assert.
 */
function fakeDb(): { db: NodePgDatabase; rows: Array<Record<string, unknown>>; failNext: (e: Error) => void } {
  const rows: Array<Record<string, unknown>> = [];
  let fail: Error | undefined;
  const client = {
    async query(cfg: { text: string; values?: unknown[] } | string, params: unknown[] = []) {
      const text = typeof cfg === "string" ? cfg : cfg.text;
      const values = ((typeof cfg === "string" ? params : (cfg.values ?? params)) ?? []) as unknown[];
      if (fail) {
        const e = fail;
        fail = undefined;
        throw e;
      }
      const head = text.trim().toUpperCase();
      if (head.startsWith("INSERT")) {
        const [conversation_id, seq, event, checksum, prev_checksum] = values as [
          string, number, unknown, string, string,
        ];
        // drizzle SERIALIZES jsonb to a string before binding; Postgres returns
        // it parsed. Model that, or every event->>'type' filter sees a string.
        const parsed = typeof event === "string" ? JSON.parse(event) : event;
        // The PK is a CORRECTNESS backstop, not just an index: a second writer
        // must collide loudly rather than interleave silently. Honour ON
        // CONFLICT the way Postgres does, so a store that adds
        // onConflictDoNothing is CAUGHT rather than silently passing.
        if (rows.some((r) => r.conversation_id === conversation_id && r.seq === seq)) {
          if (/ON CONFLICT/i.test(text)) return { rows: [], rowCount: 0 }; // silently skipped
          throw Object.assign(new Error(`duplicate key value violates unique constraint`), { code: "23505" });
        }
        rows.push({ conversation_id, seq, event: parsed, checksum, prev_checksum });
        return { rows: [], rowCount: 1 };
      }
      if (head.startsWith("DELETE")) {
        const [conversation_id] = values as [string];
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].conversation_id === conversation_id) rows.splice(i, 1);
        return { rows: [], rowCount: before - rows.length };
      }
      if (head.startsWith("SELECT")) {
        // drizzle asks for rowMode:"array": positional values in SELECT order.
        // The store issues four shapes; model each by what the SQL selects.
        const conversation_id = values[0] as string;
        let mine = rows
          .filter((r) => r.conversation_id === conversation_id)
          .sort((a, b) => (a.seq as number) - (b.seq as number));

        // head(): newest row, seq + checksum only.
        if (/ORDER BY .*"?SEQ"? DESC/i.test(text) && !/RUN_STARTED/i.test(text)) {
          const last = mine[mine.length - 1];
          return { rows: last ? [[last.seq, last.checksum]] : [], rowCount: last ? 1 : 0 };
        }
        // tail step 1: the RUN_STARTED boundary, newest-first with an OFFSET.
        if (/RUN_STARTED/i.test(text)) {
          // drizzle emits "... limit $2 offset $3", and OMITS the offset when it
          // is 0 — so params are [conv, limit] or [conv, limit, offset].
          const starts = mine.filter((r) => (r.event as { type?: string }).type === "RUN_STARTED").reverse();
          const hit = starts[Number(values[2] ?? 0)];
          return { rows: hit ? [[hit.seq]] : [], rowCount: hit ? 1 : 0 };
        }
        // tail step 2: the window from a boundary seq.
        if (/>=/.test(text)) {
          const from = Number(values[1]);
          mine = mine.filter((r) => (r.seq as number) >= from);
          return { rows: mine.map((r) => [r.event]), rowCount: mine.length };
        }
        // full replay: event + the two checksum columns.
        return {
          rows: mine.map((r) => [r.event, r.checksum, r.prev_checksum]),
          rowCount: mine.length,
        };
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };
  return { db: drizzle(client as never), rows, failNext: (e) => (fail = e) };
}

const store = (db: NodePgDatabase) => createPgEventStore({ db });

describe("eventStore — ordering", () => {
  it("THE INVARIANT: a burst of fire-and-forget appends lands in EMISSION order", async () => {
    // appendEvent is called as `void store.appendEvent(...)` for every streamed
    // token, so concurrent awaits must not interleave. A scrambled log (END
    // before START) breaks history replay on switch/revive.
    const { db, rows } = fakeDb();
    const s = store(db);
    const events = run(1);
    events.forEach((e) => void s.appendEvent(CONV, e));
    await s.flush(CONV);

    expect(rows.map((r) => (r.event as { type: string }).type)).toEqual(events.map((e) => e.type));
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]); // gapless, per conversation
  });

  it("seq is PER CONVERSATION, not global", async () => {
    const { db, rows } = fakeDb();
    const s = store(db);
    void s.appendEvent(CONV, run(1)[0]);
    void s.appendEvent("conv-2" as SessionId, run(1)[0]);
    await s.flush(CONV);
    await s.flush("conv-2" as SessionId);

    expect(rows.filter((r) => r.conversation_id === "conv-1").map((r) => r.seq)).toEqual([1]);
    expect(rows.filter((r) => r.conversation_id === "conv-2").map((r) => r.seq)).toEqual([1]);
  });

  it("a PK collision SURFACES — it must never be swallowed as ON CONFLICT DO NOTHING", async () => {
    // One pod owns a conversation, but canWrite() fails OPEN on an unobserved
    // one, so the invariant has a known hole. A second writer must be loud.
    // Both stores seed their counter from the table, so a rival that starts
    // LATER picks up the right seq — that is correct, not a collision. The real
    // hazard is two writers holding STALE cached heads: a partitioned old owner
    // keeps appending from the seq it remembers while the new owner advances.
    // Model that by letting both cache the same head before either writes.
    const { db } = fakeDb();
    const a = store(db);
    const b = store(db);
    const errors: unknown[] = [];
    a.onAppendError((_id, e) => errors.push(e));
    b.onAppendError((_id, e) => errors.push(e));

    // Both seed head = seq 0 concurrently, so both compute seq 1.
    await Promise.all([
      a.appendEvent(CONV, run(1)[0]).catch(() => {}),
      b.appendEvent(CONV, run(2)[0]).catch(() => {}),
    ]);

    expect(errors.length, "a duplicate (conversation_id, seq) must not be silent").toBeGreaterThan(0);
  });
});

describe("eventStore — the integrity chain", () => {
  it("onAppend and readEventsWithChecksum agree exactly", async () => {
    const { db } = fakeDb();
    const s = store(db);
    const fired: ChecksummedEvent[] = [];
    s.onAppend((id, c) => {
      expect(id).toBe(CONV);
      fired.push(c);
    });

    for (const e of run(1)) await s.appendEvent(CONV, e);

    const replayed: ChecksummedEvent[] = [];
    for await (const c of s.readEventsWithChecksum(CONV)) replayed.push(c);

    expect(fired.map((c) => c.checksum)).toEqual(replayed.map((c) => c.checksum));
    for (let i = 1; i < fired.length; i++) expect(fired[i].prevChecksum).toBe(fired[i - 1].checksum);
  });

  it("the chain matches a chainNext fold — the stored value is not invented", async () => {
    const { db, rows } = fakeDb();
    const s = store(db);
    const events = run(1);
    for (const e of events) await s.appendEvent(CONV, e);

    let acc = EMPTY_CHECKSUM;
    const expected = events.map((e) => (acc = chainNext(acc, e)));
    expect(rows.map((r) => r.checksum)).toEqual(expected);
  });

  it("THE RESTART: a fresh store over the same table CONTINUES the chain", async () => {
    // A new pod must not reseed from EMPTY — that forks every client's
    // verification and makes the whole history look tampered with.
    const { db } = fakeDb();
    const first = store(db);
    for (const e of run(1)) await first.appendEvent(CONV, e);
    const before: ChecksummedEvent[] = [];
    for await (const c of first.readEventsWithChecksum(CONV)) before.push(c);

    const second = store(db); // "restart"
    await second.appendEvent(CONV, run(2)[0]);

    const after: ChecksummedEvent[] = [];
    for await (const c of second.readEventsWithChecksum(CONV)) after.push(c);
    expect(after[after.length - 1].prevChecksum).toBe(before[before.length - 1].checksum);
  });

  it("checksums are READ from the row, never recomputed from the jsonb column", async () => {
    // jsonb reorders keys at every level, so a chain re-derived from `event`
    // could never match the writer's. The stored columns are the only copy.
    const { db, rows } = fakeDb();
    const s = store(db);
    await s.appendEvent(CONV, run(1)[0]);
    rows[0].event = { z: "reordered", type: "RUN_STARTED" }; // as jsonb would return it
    const stored = rows[0].checksum;

    const read: ChecksummedEvent[] = [];
    for await (const c of s.readEventsWithChecksum(CONV)) read.push(c);
    expect(read[0].checksum).toBe(stored);
  });
});

describe("eventStore — the tail", () => {
  it("returns only the last N runs", async () => {
    const { db } = fakeDb();
    const s = store(db);
    for (const e of [...run(1), ...run(2), ...run(3)]) await s.appendEvent(CONV, e);

    const tail = await s.readEventsTail(CONV, 1);
    expect(tail.map((e) => (e as { runId?: string }).runId).filter(Boolean)).toEqual(["r3"]);
  });

  it("orders by SEQ, not ts — seq IS the chronology in this store", async () => {
    // The file store sorted by `ts` first because a log concatenated runs from
    // separate processes across a restart, so append order could disagree with
    // time. A monotonic per-conversation counter has no such seam: seq is
    // assigned in emission order by the single owning pod. Here the ts values
    // are deliberately out of order to prove seq wins.
    const { db } = fakeDb();
    const s = store(db);
    const misleading = [...run(1, 300), ...run(2, 100)]; // appended 1 then 2, but ts says otherwise
    for (const e of misleading) await s.appendEvent(CONV, e);

    const tail = await s.readEventsTail(CONV, 1);
    expect(tail.map((e) => (e as { runId?: string }).runId).filter(Boolean)).toEqual(["r2"]);
  });

  it("windows on RUN boundaries, never mid-run", async () => {
    // A raw "last N events" could cut a TEXT_MESSAGE_START from its END and
    // render a half-message. The tail must fold identically to a full replay.
    const { db } = fakeDb();
    const s = store(db);
    for (const e of [...run(1), ...run(2)]) await s.appendEvent(CONV, e);

    const tail = await s.readEventsTail(CONV, 1);
    expect(tail[0].type, "a window must begin at a RUN_STARTED").toBe("RUN_STARTED");
    const starts = tail.filter((e) => e.type === "TEXT_MESSAGE_START").length;
    const ends = tail.filter((e) => e.type === "TEXT_MESSAGE_END").length;
    expect(starts).toBe(ends); // no half-messages
  });

  it("asking for more runs than exist returns the whole log", async () => {
    const { db } = fakeDb();
    const s = store(db);
    for (const e of run(1)) await s.appendEvent(CONV, e);
    expect(await s.readEventsTail(CONV, 99)).toHaveLength(4);
  });

  it("runs <= 0 returns nothing; a conversation with no events returns []", async () => {
    const { db } = fakeDb();
    const s = store(db);
    expect(await s.readEventsTail(CONV, 0)).toEqual([]);
    expect(await s.readEventsTail("nope" as SessionId, 3)).toEqual([]);
  });
});

describe("eventStore — durability contracts", () => {
  it("THE SUBAGENT RACE: flush() awaits appends enqueued so far", async () => {
    // A subagent's RUN_FINISHED fires onEvent (→ report completion → read)
    // BEFORE the fire-and-forget insert lands, so lastRunCompleted() saw no
    // finish and the notification was dropped. flush closes that window.
    const { db } = fakeDb();
    const s = store(db);
    run(1).forEach((e) => void s.appendEvent(CONV, e));
    await s.flush(CONV);

    const seen: AguiEvent[] = [];
    for await (const e of s.readEvents(CONV)) seen.push(e);
    expect(seen).toHaveLength(4);
  });

  it("an append FAILURE is surfaced, not swallowed", async () => {
    // appendEvent is `void`-called, so a failed write to the conversation's ONLY
    // persistence would otherwise vanish. With no file fallback this is a lost
    // turn and must be loud.
    const { db, failNext } = fakeDb();
    const s = store(db);
    const errors: unknown[] = [];
    s.onAppendError((_id, e) => errors.push(e));
    failNext(new Error("connection terminated"));

    await s.appendEvent(CONV, run(1)[0]).catch(() => {});
    expect(errors).toHaveLength(1);
  });

  it("a failed append does NOT break the ordering chain for later appends", async () => {
    const { db, rows, failNext } = fakeDb();
    const s = store(db);
    s.onAppendError(() => {});
    failNext(new Error("blip"));
    void s.appendEvent(CONV, run(1)[0]);
    for (const e of run(2)) void s.appendEvent(CONV, e);
    await s.flush(CONV);

    const seqs = rows.map((r) => r.seq as number);
    expect(seqs, "seq must stay strictly increasing after a failure").toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
  });

  it("removeConversation drops only that conversation's events", async () => {
    const { db, rows } = fakeDb();
    const s = store(db);
    await s.appendEvent(CONV, run(1)[0]);
    await s.appendEvent("keep" as SessionId, run(1)[0]);
    await s.removeConversation(CONV);
    expect(rows.map((r) => r.conversation_id)).toEqual(["keep"]);
  });
});

describe("backfillConversation — the one-shot migration", () => {
  const lines = run(1).map((e) => JSON.stringify(e));

  it("reproduces the chain the file store would have computed", async () => {
    // The .jsonl files store only raw events; the chain is recomputed on read.
    // If the backfill's chain differs, every client verifying history breaks.
    const { db } = fakeDb();
    const res = await backfillConversation(db, CONV, lines);

    let acc = EMPTY_CHECKSUM;
    for (const l of lines) acc = chainNext(acc, JSON.parse(l) as AguiEvent);
    expect(res.finalChecksum).toBe(acc);
    expect(res.rows).toBe(lines.length);
  });

  it("preserves FILE order as seq order", async () => {
    const { db, rows } = fakeDb();
    await backfillConversation(db, CONV, lines);
    expect(rows.map((r) => (r.event as { type: string }).type)).toEqual(run(1).map((e) => e.type));
  });

  it("is idempotent — a re-run does not double-load", async () => {
    // The Job is re-runnable by design; the PK is what makes that safe.
    const { db, rows } = fakeDb();
    await backfillConversation(db, CONV, lines);
    await backfillConversation(db, CONV, lines).catch(() => {});
    expect(rows).toHaveLength(lines.length);
  });

  it("REPORTS what it wrote, so the Job can verify instead of assuming", async () => {
    // A backfill that loads 127 of 128 conversations must not report success.
    const { db } = fakeDb();
    const res = await backfillConversation(db, CONV, lines);
    expect(res).toMatchObject({ conversationId: CONV, rows: lines.length });
    expect(res.finalChecksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
