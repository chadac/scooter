/**
 * Contract test for the conversation event log on Postgres: emission order under
 * fire-and-forget appends, the integrity chain continuing across a restart, the
 * tail windowing and flush(). Runs against a real drizzle client over an
 * in-memory Postgres double so the store's generated-model queries are exercised.
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

/** An in-memory Postgres under a real drizzle client, with rows in an array so tests can inspect physical order. */
function fakeDb(): {
  db: NodePgDatabase;
  rows: Array<Record<string, unknown>>;
  failNext: (e: Error) => void;
  /** Full-replay pages served so far. */
  replayPages: () => number;
  assign: (conv: string, a: { hostPod: string | null; hostGeneration?: number }) => void;
} {
  const rows: Array<Record<string, unknown>> = [];
  // The conversations row the fence reads, where an absent row means deleted.
  const assigned = new Map<string, { hostPod: string | null; hostGeneration?: number }>();
  let fail: Error | undefined;
  let replayPages = 0;
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
        // drizzle serializes jsonb to a string before binding and Postgres returns it parsed.
        const parsed = typeof event === "string" ? JSON.parse(event) : event;
        // The fence rides this statement, evaluated before the PK.
        if (/WHERE EXISTS/i.test(text)) {
          // The subquery correlates on the conversation id, which is therefore bound a second time ahead of the claim: [...5 row values, id, pod, gen?].
          const [, pod, gen] = values.slice(5) as [string, string, number | undefined];
          const a = assigned.get(conversation_id);
          const allowed =
            a !== undefined && // the row must EXIST
            a.hostPod === pod &&
            (gen === undefined || Number(a.hostGeneration ?? 0) === Number(gen));
          if (!allowed) return { rows: [], rowCount: 0 };
        }
        // Honour ON CONFLICT the way Postgres does, so a store that adds onConflictDoNothing is caught.
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
      if (head.startsWith("SELECT") && /FROM\s+"?CONVERSATIONS"?/i.test(text)) {
        // The refusal-cause read, for the sampled log line.
        const a = assigned.get(values[0] as string);
        return a ? { rows: [[a.hostPod, a.hostGeneration ?? 0]], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (head.startsWith("SELECT")) {
        // drizzle asks for rowMode:"array", so each of the store's query shapes is modelled by what its SQL selects.
        const conversation_id = values[0] as string;
        let mine = rows
          .filter((r) => r.conversation_id === conversation_id)
          .sort((a, b) => (a.seq as number) - (b.seq as number));

        // The conflict check: the checksum at one exact seq.
        if (/^SELECT\s+"?CHECKSUM"?\s+FROM/i.test(head)) {
          const hit = mine.find((r) => r.seq === Number(values[1]));
          return { rows: hit ? [[hit.checksum]] : [], rowCount: hit ? 1 : 0 };
        }
        // tail-by-count selects only "event", which is what tells it apart from head().
        if (/ORDER BY .*"?SEQ"? DESC/i.test(text) && /^SELECT\s+"?EVENT"?\s+FROM/i.test(head)) {
          // DESC as Postgres returns it; the store reverses to chronological order.
          const n = Number(values[1] ?? mine.length);
          const newest = mine.slice(-n).reverse();
          return { rows: newest.map((r) => [r.event]), rowCount: newest.length };
        }
        // head(): the newest row, seq and checksum only.
        if (/ORDER BY .*"?SEQ"? DESC/i.test(text) && !/RUN_STARTED/i.test(text)) {
          const last = mine[mine.length - 1];
          return { rows: last ? [[last.seq, last.checksum]] : [], rowCount: last ? 1 : 0 };
        }
        // run markers: the settlement read.
        if (/CANCEL_REQUESTED/i.test(text)) {
          const MARKERS = ["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "CANCEL_REQUESTED"];
          const hits = mine.filter((r) => MARKERS.includes((r.event as { type?: string }).type ?? ""));
          return { rows: hits.map((r) => [r.event]), rowCount: hits.length };
        }
        // tail step 1: the RUN_STARTED boundary, newest-first with an OFFSET.
        if (/RUN_STARTED/i.test(text)) {
          // drizzle omits the offset when it is 0, so params are [conv, limit] or [conv, limit, offset].
          const starts = mine.filter((r) => (r.event as { type?: string }).type === "RUN_STARTED").reverse();
          const hit = starts[Number(values[2] ?? 0)];
          return { rows: hit ? [[hit.seq]] : [], rowCount: hit ? 1 : 0 };
        }
        // resume: rows from the cursor seq on, params [conv, afterSeq, limit].
        if (/>=/.test(text) && /^SELECT\s+"?SEQ"?/i.test(head)) {
          const page = mine.filter((r) => (r.seq as number) >= Number(values[1])).slice(0, Number(values[2]));
          return { rows: page.map((r) => [r.seq, r.event, r.checksum, r.prev_checksum]), rowCount: page.length };
        }
        // tail step 2: the window from a boundary seq.
        if (/>=/.test(text)) {
          const from = Number(values[1]);
          mine = mine.filter((r) => (r.seq as number) >= from);
          return { rows: mine.map((r) => [r.event]), rowCount: mine.length };
        }
        // full replay: one keyset page of seq, event and the two checksum columns, params [conv, after, limit].
        const page = mine.filter((r) => (r.seq as number) > Number(values[1])).slice(0, Number(values[2]));
        replayPages++;
        return {
          rows: page.map((r) => [r.seq, r.event, r.checksum, r.prev_checksum]),
          rowCount: page.length,
        };
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };
  return {
    db: drizzle(client as never),
    rows,
    failNext: (e) => (fail = e),
    replayPages: () => replayPages,
    assign: (conv, a) => assigned.set(conv, a),
  };
}

const store = (db: NodePgDatabase) => createPgEventStore({ db });

/** A store that presents `pod` (and `gen`, when known) as its claim on every append. */
const fencedStore = (db: NodePgDatabase, pod: string, gen?: number) =>
  createPgEventStore({ db, fence: { pod, generation: () => gen } });

describe("eventStore — ordering", () => {
  it("THE INVARIANT: a burst of fire-and-forget appends lands in EMISSION order", async () => {
    // appendEvent is `void`-called for every streamed token, so concurrent awaits must not interleave.
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

  it("re-appending the SAME event at the same seq is idempotent, not a collision", async () => {
    // A retry after an insert committed but its reply was lost presents the identical row.
    const { db, rows } = fakeDb();
    const a = store(db);
    const b = store(db);
    const errors: unknown[] = [];
    a.onAppendError((_id, e) => errors.push(e));
    b.onAppendError((_id, e) => errors.push(e));
    const ev = run(1)[0];

    await Promise.all([a.appendEvent(CONV, ev), b.appendEvent(CONV, ev)]);

    expect(errors).toEqual([]);
    expect(rows.map((r) => r.seq)).toEqual([1]);
    // The head advanced past the existing row, so the next append continues the chain.
    await b.appendEvent(CONV, run(1)[1]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("a PK collision SURFACES — it must never be swallowed as ON CONFLICT DO NOTHING", async () => {
    // Two writers holding stale cached heads is modelled by letting both cache the same head before either writes.
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

// --- the append fence ---------------------------------------------------------------------
//
// The fence consults the conversations row inside the insert so a superseded pod is refused by the write it was already making, while a missing or unclaimed row must still append because a new conversation streams its first turn before any host is assigned.

describe("eventStore — the append fence", () => {
  it("THE FENCE: the row naming another host refuses the append, and nothing is written", async () => {
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-2", hostGeneration: 4 });
    const s = fencedStore(db, "host-1", 4);

    // Losing the claim resolves rather than rejects, since every caller `void`s this.
    await expect(s.appendEvent(CONV, run(1)[0])).resolves.toBeUndefined();

    expect(rows).toEqual([]);
  });

  it("a refused append notifies NO listener and leaves no gap in seq", async () => {
    // A phantom onAppend would hand the integrity SSE stream a checksum no reader can find in the table.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-2", hostGeneration: 4 });
    const s = fencedStore(db, "host-1", 4);
    const fired: ChecksummedEvent[] = [];
    s.onAppend((_id, c) => fired.push(c));
    const errors: unknown[] = [];
    s.onAppendError((_id, e) => errors.push(e));

    await s.appendEvent(CONV, run(1)[0]);
    expect(fired, "nothing committed, so nothing to announce").toEqual([]);
    expect(errors, "a fence refusal is not a persistence failure").toEqual([]);

    // When the claim comes back, seq must resume at 1 and the chain must still start from EMPTY.
    assign(CONV, { hostPod: "host-1", hostGeneration: 4 });
    await s.appendEvent(CONV, run(2)[0]);
    expect(rows.map((r) => r.seq)).toEqual([1]);
    expect(rows[0].prev_checksum).toBe(EMPTY_CHECKSUM);
  });

  it("the EPOCH fences a pod the row still names as host", async () => {
    // A StatefulSet pod reuses its name, so only the generation can catch a pod reassigned away and back.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-1", hostGeneration: 7 });

    await fencedStore(db, "host-1", 5).appendEvent(CONV, run(1)[0]);
    expect(rows).toEqual([]);

    await fencedStore(db, "host-1", 7).appendEvent(CONV, run(2)[0]);
    expect(rows).toHaveLength(1);
  });

  it("an UNCLAIMED row refuses appends: no assignment, no writer", async () => {
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: null });

    await fencedStore(db, "host-1", 3).appendEvent(CONV, run(1)[0]);

    expect(rows).toEqual([]);
  });

  it("FAILS CLOSED on a missing row: no row means DELETED, not 'not created yet'", async () => {
    // No row now means a teardown raced this append.
    const { db, rows } = fakeDb(); // nothing assigned: no row at all
    const s = fencedStore(db, "host-1", 3);

    await expect(s.appendEvent("conv-deleted" as SessionId, run(1)[0])).resolves.toBeUndefined();

    expect(rows).toEqual([]);
  });

  it("no observed generation narrows the fence to pod identity — it does not widen it", async () => {
    // Between boot and the first watch event the pod knows it is the host but not at which epoch, so it presents none.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-1", hostGeneration: 9 });
    await fencedStore(db, "host-1").appendEvent(CONV, run(1)[0]);
    expect(rows, "still the named host, epoch unknown -> allowed").toHaveLength(1);

    assign(CONV, { hostPod: "host-2", hostGeneration: 9 });
    await fencedStore(db, "host-1").appendEvent(CONV, run(2)[0]);
    expect(rows, "another host, epoch unknown -> still refused").toHaveLength(1);
  });

  it("an UNFENCED store appends unconditionally — single-replica is untouched", async () => {
    // Without POD_NAME there is no second writer to fence against.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "someone-else", hostGeneration: 12 });

    await store(db).appendEvent(CONV, run(1)[0]);

    expect(rows).toHaveLength(1);
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
    // A new pod must not reseed from EMPTY, which would fork every client's verification.
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
    // jsonb reorders keys, so a chain re-derived from `event` could never match the writer's.
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

describe("eventStore — the full replay streams", () => {
  it("pages a long log on seq and yields every event once, in order", async () => {
    const { db, rows, replayPages } = fakeDb();
    // 1,201 rows: three pages of the store's 500.
    for (let i = 1; i <= 1201; i++) {
      rows.push({ conversation_id: CONV, seq: i, event: { type: "CUSTOM", n: i }, checksum: `c${i}`, prev_checksum: `c${i - 1}` });
    }
    const seen: number[] = [];
    for await (const e of store(db).readEvents(CONV)) seen.push((e as { n: number }).n);
    expect(seen).toEqual(Array.from({ length: 1201 }, (_, i) => i + 1));
    expect(replayPages()).toBe(3);
  });

  it("stops after the first page when a consumer breaks early", async () => {
    const { db, rows, replayPages } = fakeDb();
    for (let i = 1; i <= 1201; i++) {
      rows.push({ conversation_id: CONV, seq: i, event: { type: "CUSTOM", n: i }, checksum: `c${i}`, prev_checksum: `c${i - 1}` });
    }
    for await (const e of store(db).readEvents(CONV)) if ((e as { n: number }).n === 10) break;
    expect(replayPages()).toBe(1);
  });
});

describe("eventStore — run markers", () => {
  it("returns only the run markers, in seq order", async () => {
    const { db } = fakeDb();
    const s = store(db);
    const log = [
      ...run(1),
      { type: "RUN_FINISHED", threadId: "t", runId: "r1" },
      { type: "CANCEL_REQUESTED", runId: "r2" },
      ...run(2),
    ] as AguiEvent[];
    for (const e of log) await s.appendEvent(CONV, e);

    const types = (await s.readRunMarkers(CONV)).map((e) => e.type);
    expect(types).toEqual(["RUN_STARTED", "RUN_FINISHED", "CANCEL_REQUESTED", "RUN_STARTED"]);
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
    // The ts values are deliberately out of order to prove seq wins.
    const { db } = fakeDb();
    const s = store(db);
    const misleading = [...run(1, 300), ...run(2, 100)]; // appended 1 then 2, but ts says otherwise
    for (const e of misleading) await s.appendEvent(CONV, e);

    const tail = await s.readEventsTail(CONV, 1);
    expect(tail.map((e) => (e as { runId?: string }).runId).filter(Boolean)).toEqual(["r2"]);
  });

  it("windows on RUN boundaries, never mid-run", async () => {
    // The tail must fold identically to a full replay, never cutting a message in half.
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
    // A subagent's RUN_FINISHED fires onEvent before the fire-and-forget insert lands, and flush closes that window.
    const { db } = fakeDb();
    const s = store(db);
    run(1).forEach((e) => void s.appendEvent(CONV, e));
    await s.flush(CONV);

    const seen: AguiEvent[] = [];
    for await (const e of s.readEvents(CONV)) seen.push(e);
    expect(seen).toHaveLength(4);
  });

  it("an append FAILURE is surfaced, not swallowed", async () => {
    // appendEvent is `void`-called, so a failed write would otherwise vanish.
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
    // The .jsonl files store only raw events, so the backfill must compute the same chain the file store did on read.
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
    // The PK is what makes the re-runnable Job safe.
    const { db, rows } = fakeDb();
    await backfillConversation(db, CONV, lines);
    await backfillConversation(db, CONV, lines).catch(() => {});
    expect(rows).toHaveLength(lines.length);
  });

  it("REPORTS what it wrote, so the Job can verify instead of assuming", async () => {
    // A partial backfill must not report success.
    const { db } = fakeDb();
    const res = await backfillConversation(db, CONV, lines);
    expect(res).toMatchObject({ conversationId: CONV, rows: lines.length });
    expect(res.finalChecksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("eventStore — the tail bounded by EVENT COUNT", () => {
  // `runs` is a poor proxy for size, since one turn with many tool calls emits hundreds of events.
  it("returns at most `limit` events", async () => {
    const { db } = fakeDb();
    const s = store(db);
    for (let i = 0; i < 50; i++) await s.appendEvent(CONV, run(1)[i % 4]);
    expect((await s.readEventsTailByCount(CONV, 10)).length).toBeLessThanOrEqual(10);
  });

  it("returns the NEWEST events, in order", async () => {
    const { db } = fakeDb();
    const s = store(db);
    for (let i = 1; i <= 20; i++) {
      await s.appendEvent(CONV, { type: "TEXT_MESSAGE_START", messageId: `m${i}`, role: "assistant" } as never);
    }
    const tail = await s.readEventsTailByCount(CONV, 3);
    expect(tail.map((e) => (e as { messageId: string }).messageId)).toEqual(["m18", "m19", "m20"]);
  });

  it("APPLIES the boundary trim — a raw cut mid-message is not returned", async () => {
    // Direct trimToBoundary tests do not prove the store calls it.
    const { db } = fakeDb();
    const s = store(db);
    // A tool call, then a clean run: a 3-event window cuts inside the tool call.
    for (const e of [
      { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "x" },
      { type: "TOOL_CALL_RESULT", toolCallId: "t1" },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      { type: "RUN_STARTED", threadId: "t", runId: "r9" },
      { type: "TEXT_MESSAGE_START", messageId: "m9", role: "assistant" },
    ] as never[]) {
      await s.appendEvent(CONV, e);
    }
    const tail = await s.readEventsTailByCount(CONV, 4);
    expect(
      (tail[0] as { type: string }).type,
      "the window must START at something that can open a message",
    ).toBe("RUN_STARTED");
  });

  it("limit <= 0 returns nothing; an empty conversation returns []", async () => {
    const { db } = fakeDb();
    const s = store(db);
    expect(await s.readEventsTailByCount(CONV, 0)).toEqual([]);
    expect(await s.readEventsTailByCount("nope" as SessionId, 5)).toEqual([]);
  });
});

describe("trimToBoundary", () => {
  const ev = (type: string) => ({ type }) as never;

  it("THE POINT: drops a leading fragment so the window can actually fold", async () => {
    // A raw seq cut lands mid-item, and the client's fold discards such a window entirely.
    const { trimToBoundary } = await import("../../src/session/eventStore.js");
    const out = trimToBoundary([ev("TOOL_CALL_RESULT"), ev("TOOL_CALL_END"), ev("RUN_STARTED"), ev("TEXT_MESSAGE_START")]);
    expect(out.map((e) => (e as { type: string }).type)).toEqual(["RUN_STARTED", "TEXT_MESSAGE_START"]);
  });

  it("leaves an already-clean window untouched", async () => {
    const { trimToBoundary } = await import("../../src/session/eventStore.js");
    const clean = [ev("RUN_STARTED"), ev("TEXT_MESSAGE_START"), ev("TEXT_MESSAGE_CONTENT")];
    expect(trimToBoundary(clean)).toHaveLength(3);
  });

  it("returns [] when NOTHING in the window can open — better than a broken prefix", async () => {
    const { trimToBoundary } = await import("../../src/session/eventStore.js");
    expect(trimToBoundary([ev("TOOL_CALL_RESULT"), ev("TEXT_MESSAGE_CONTENT")])).toEqual([]);
  });
});

describe("eventStore — resuming after a cursor", () => {
  it("returns the anchor checksum and only the events after it", async () => {
    const { db } = fakeDb();
    const s = store(db);
    for (const e of [...run(1), ...run(2)]) await s.appendEvent(CONV, e);
    const all: ChecksummedEvent[] = [];
    for await (const c of s.readEventsWithChecksum(CONV)) all.push(c);

    const r = await s.readEventsAfter(CONV, 4, 100);

    expect(r.anchor).toBe(all[3].checksum);
    expect(r.events.map((c) => c.seq)).toEqual([5, 6, 7, 8]);
    expect(r.events).toEqual(all.slice(4));
    expect(r.more).toBe(false);
  });

  it("flags a gap longer than the limit", async () => {
    const { db } = fakeDb();
    const s = store(db);
    for (const e of [...run(1), ...run(2)]) await s.appendEvent(CONV, e);

    const r = await s.readEventsAfter(CONV, 2, 3);

    expect(r.events.map((c) => c.seq)).toEqual([3, 4, 5]);
    expect(r.more).toBe(true);
  });

  it("has no anchor for a cursor past the head", async () => {
    const { db } = fakeDb();
    const s = store(db);
    for (const e of run(1)) await s.appendEvent(CONV, e);

    const r = await s.readEventsAfter(CONV, 9, 100);

    expect(r.anchor).toBeUndefined();
    expect(r.events).toEqual([]);
  });

  it("onAppend carries the seq the row was written at", async () => {
    const { db } = fakeDb();
    const s = store(db);
    const seqs: Array<number | undefined> = [];
    s.onAppend((_, c) => seqs.push(c.seq));

    for (const e of run(1)) await s.appendEvent(CONV, e);

    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});
