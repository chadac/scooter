/**
 * Tier 1 contract — the conversation event log on Postgres.
 *
 * Stage 3 of the PoC process: these are written against the DESIGN and fail
 * until Stage 5 implements it. They encode the invariants the file store proved
 * over many incidents, so a Postgres store that passes them is a safe swap.
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
 *
 * SKIPPED until Stage 5 fills in pgEventStore — they currently fail with
 * "not implemented", which is correct but would break CI. Drop the gate (set
 * RUN_PG_EVENT_STORE=1 to run them meanwhile) as the implementation lands; a
 * test that never runs is worse than no test, so this MUST be removed then.
 */
const implemented = process.env.RUN_PG_EVENT_STORE === "1";

import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { createPgEventStore, backfillConversation } from "../../src/session/pgEventStore.js";
import { chainNext, EMPTY_CHECKSUM } from "../../src/agui/integrity.js";
import { tailByRuns } from "../../src/session/eventWindow.js";
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
      const values = (typeof cfg === "string" ? params : (cfg.values ?? params)) as unknown[];
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
        // The PK is a CORRECTNESS backstop, not just an index: a second writer
        // must collide loudly rather than interleave silently.
        if (rows.some((r) => r.conversation_id === conversation_id && r.seq === seq)) {
          throw Object.assign(new Error(`duplicate key value violates unique constraint`), { code: "23505" });
        }
        rows.push({ conversation_id, seq, event, checksum, prev_checksum });
        return { rows: [], rowCount: 1 };
      }
      if (head.startsWith("DELETE")) {
        const [conversation_id] = values as [string];
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].conversation_id === conversation_id) rows.splice(i, 1);
        return { rows: [], rowCount: before - rows.length };
      }
      if (head.startsWith("SELECT")) {
        const [conversation_id] = values as [string];
        const out = rows
          .filter((r) => r.conversation_id === conversation_id)
          .sort((a, b) => (a.seq as number) - (b.seq as number))
          .map((r) => [r.seq, r.event, r.checksum, r.prev_checksum]);
        return { rows: out, rowCount: out.length };
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };
  return { db: drizzle(client as never), rows, failNext: (e) => (fail = e) };
}

const store = (db: NodePgDatabase) => createPgEventStore({ db });

describe.skipIf(!implemented)("pgEventStore — ordering", () => {
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
    const { db } = fakeDb();
    const s = store(db);
    const errors: unknown[] = [];
    s.onAppendError((_id, e) => errors.push(e));

    await s.appendEvent(CONV, run(1)[0]);
    // A second store sharing the db restarts its counter at 1 → same (conv, seq).
    const rival = store(db);
    await rival.appendEvent(CONV, run(2)[0]).catch((e) => errors.push(e));
    await s.flush(CONV);

    expect(errors.length, "a duplicate (conversation_id, seq) must not be silent").toBeGreaterThan(0);
  });
});

describe.skipIf(!implemented)("pgEventStore — the integrity chain", () => {
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

describe.skipIf(!implemented)("pgEventStore — the tail", () => {
  it("returns only the last N runs", async () => {
    const { db } = fakeDb();
    const s = store(db);
    for (const e of [...run(1), ...run(2), ...run(3)]) await s.appendEvent(CONV, e);

    const tail = await s.readEventsTail(CONV, 1);
    expect(tail.map((e) => (e as { runId?: string }).runId).filter(Boolean)).toEqual(["r3"]);
  });

  it("THE RESTART SEAM: the window is by TIME, not append order", async () => {
    // A conversation that survived restarts concatenates runs from separate
    // processes, so append order != chronology. Scanning back for the last N
    // RUN_STARTED in seq order windows across the seam and renders scrambled
    // history — the bug tailByRuns' orderByTime exists to prevent.
    const { db } = fakeDb();
    const s = store(db);
    const scrambled = [...run(1, 100), ...run(3, 300), ...run(2, 200)]; // appended out of chronology
    for (const e of scrambled) await s.appendEvent(CONV, e);

    // The contract IS tailByRuns: same input, same window.
    expect(await s.readEventsTail(CONV, 1)).toEqual(tailByRuns(scrambled, 1));
    expect(await s.readEventsTail(CONV, 2)).toEqual(tailByRuns(scrambled, 2));
  });

  it("returns the window in TIME order, as tailByRuns does", async () => {
    const { db } = fakeDb();
    const s = store(db);
    const scrambled = [...run(1, 100), ...run(3, 300), ...run(2, 200)];
    for (const e of scrambled) await s.appendEvent(CONV, e);

    const tail = await s.readEventsTail(CONV, 2);
    const ts = tail.map((e) => (e as { ts?: number }).ts).filter((t): t is number => t !== undefined);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("runs <= 0 returns nothing; a conversation with no events returns []", async () => {
    const { db } = fakeDb();
    const s = store(db);
    expect(await s.readEventsTail(CONV, 0)).toEqual([]);
    expect(await s.readEventsTail("nope" as SessionId, 3)).toEqual([]);
  });
});

describe.skipIf(!implemented)("pgEventStore — durability contracts", () => {
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

describe.skipIf(!implemented)("backfillConversation — the one-shot migration", () => {
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
