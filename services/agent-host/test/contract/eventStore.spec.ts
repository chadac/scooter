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

import { describe, it, expect, vi } from "vitest";
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
function fakeDb(): {
  db: NodePgDatabase;
  rows: Array<Record<string, unknown>>;
  failNext: (e: Error) => void;
  assign: (conv: string, a: { hostPod: string | null; hostGeneration?: number }) => void;
  row: (conv: string) => { hostPod: string | null; hostGeneration: number } | undefined;
} {
  const rows: Array<Record<string, unknown>> = [];
  // The conversations row the append fence reads. Absent = no row at all, which is a real
  // state (the append can beat the INSERT) and must not refuse. host_generation is NOT NULL
  // DEFAULT 0 in the schema, so an unassigned row carries 0 — the epoch claimFence compares
  // against, and the reason the first real assignment (generation >= 1) always wins it.
  const assigned = new Map<string, { hostPod: string | null; hostGeneration: number }>();
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
      // The append is `[with claim as (update ...)] insert ... select ... [where <fence>]`,
      // so a FENCED statement starts with WITH, not INSERT.
      if (head.startsWith("INSERT") || head.startsWith("WITH")) {
        const fenced = head.startsWith("WITH");
        // Param order follows the SQL text. Fenced: [pod, id] for the claim CTE, then the
        // five row values, then [id, pod, id] for the three-way fence.
        const [conversation_id, seq, event, checksum, prev_checksum] = (
          fenced ? values.slice(2, 7) : values.slice(0, 5)
        ) as [string, number, unknown, string, string];
        // drizzle SERIALIZES jsonb to a string before binding; Postgres returns
        // it parsed. Model that, or every event->>'type' filter sees a string.
        const parsed = typeof event === "string" ? JSON.parse(event) : event;

        if (fenced) {
          const pod = values[0] as string;
          const a = assigned.get(conversation_id);
          // The CTE's UPDATE runs first and is the ARBITER: it takes the row only when
          // nobody holds it. Under real concurrency the loser re-reads the locked row and
          // matches nothing — modelled here by the claim simply not firing twice.
          const claimTook = a !== undefined && a.hostPod == null;
          if (claimTook) assigned.set(conversation_id, { ...a!, hostPod: pod });
          // Allowed if we just took it, if it was already ours, or if there is no row at
          // all (a first turn may append before anything creates one).
          const allowed = claimTook || a?.hostPod === pod || a === undefined;
          if (!allowed) return { rows: [], rowCount: 0 };
        }

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
      // THE HANDOFF CLAIM (claimFence): `update conversations set host_pod = $1,
      // host_generation = $2 where id = $3 and $4 >= host_generation`. The append-time claim
      // rides the WITH above, so this is the only standalone UPDATE the store issues. The
      // epoch predicate is modelled, not assumed — it is the whole guard against a pod on a
      // stale assignment taking the row back from a newer owner.
      if (head.startsWith("UPDATE")) {
        const [pod, generation, conversation_id] = values as [string, number, string];
        const a = assigned.get(conversation_id);
        if (!a || Number(generation) < a.hostGeneration) return { rows: [], rowCount: 0 };
        assigned.set(conversation_id, { hostPod: pod, hostGeneration: Number(generation) });
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

        // The fence-reason read-back, off the CONVERSATIONS row rather than the event log.
        // Modelled by its projection: nothing else selects host_pod.
        if (/HOST_POD/i.test(text)) {
          const a = assigned.get(conversation_id);
          return a ? { rows: [[a.hostPod, a.hostGeneration]], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        let mine = rows
          .filter((r) => r.conversation_id === conversation_id)
          .sort((a, b) => (a.seq as number) - (b.seq as number));

        // tail-by-count: newest N, selecting ONLY "event" (head() selects seq+checksum,
        // so the projection is what tells these two DESC queries apart).
        if (/ORDER BY .*"?SEQ"? DESC/i.test(text) && /^SELECT\s+"?EVENT"?\s+FROM/i.test(head)) {
          // DESC, as Postgres returns it — the store reverses to chronological order.
          const n = Number(values[1] ?? mine.length);
          const newest = mine.slice(-n).reverse();
          return { rows: newest.map((r) => [r.event]), rowCount: newest.length };
        }
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
  return {
    db: drizzle(client as never),
    rows,
    failNext: (e) => (fail = e),
    assign: (conv, a) => assigned.set(conv, { hostGeneration: 0, ...a }),
    row: (conv) => assigned.get(conv),
  };
}

/** The row read-back is DETACHED from the write chain (it must not add latency to an
 *  append), so a log line lands a microtask or two after the append resolves. Poll for it
 *  rather than asserting on the next tick — a fixed sleep is the flake this avoids. */
const awaitLine = async (spy: { mock: { calls: unknown[][] } }, needle: string) => {
  for (let i = 0; i < 100; i++) {
    const hit = spy.mock.calls.flat().map(String).find((a) => a.includes(needle));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 2));
  }
  return undefined;
};

const store = (db: NodePgDatabase) => createPgEventStore({ db });

/** A store that presents `pod` as its claim on every append. */
const fencedStore = (db: NodePgDatabase, pod: string) =>
  createPgEventStore({ db, fence: { pod } });

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

// --- THE APPEND FENCE ---------------------------------------------------------------------
//
// The test directly above is the hazard: two writers, stale cached heads, a PK collision
// that is loud but has already lost a turn. These pin the fence that stops the second
// writer from reaching the constraint at all — the row is consulted IN the insert, so a
// superseded pod is refused by the write it was already making.
//
// What the fence is deliberately NOT: an existence check. A missing or unclaimed row must
// still append, because a brand-new conversation streams its first turn before anything has
// assigned it a host, and refusing there would drop the user's first prompt.

describe("eventStore — the append fence", () => {
  it("THE FENCE: the row naming another host refuses the append, and nothing is written", async () => {
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-2" });
    const s = fencedStore(db, "host-1");

    // RESOLVES: losing the claim is an outcome, not a failure — every caller `void`s this.
    await expect(s.appendEvent(CONV, run(1)[0])).resolves.toBeUndefined();

    expect(rows).toEqual([]);
  });

  it("a refused append notifies NO listener and leaves no gap in seq", async () => {
    // A phantom onAppend would hand the integrity SSE stream a checksum no reader can find
    // in the table, which reads to a client as a corrupt chain rather than a reassignment.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-2" });
    const s = fencedStore(db, "host-1");
    const fired: ChecksummedEvent[] = [];
    s.onAppend((_id, c) => fired.push(c));
    const errors: unknown[] = [];
    s.onAppendError((_id, e) => errors.push(e));

    await s.appendEvent(CONV, run(1)[0]);
    expect(fired, "nothing committed, so nothing to announce").toEqual([]);
    expect(errors, "a fence refusal is not a persistence failure").toEqual([]);

    // The claim comes back to this pod: seq must resume at 1 (the refused event consumed
    // nothing) and the chain must still start from EMPTY.
    assign(CONV, { hostPod: "host-1" });
    await s.appendEvent(CONV, run(2)[0]);
    expect(rows.map((r) => r.seq)).toEqual([1]);
    expect(rows[0].prev_checksum).toBe(EMPTY_CHECKSUM);
  });

  it("a RELEASED row still names its last writer, so the other pod is refused", async () => {
    // #678. Suspend used to clear host_pod, and an unclaimed row does not refuse — so the
    // old owner and whichever pod the router's fallback picked both passed the fence and
    // collided on the PK, losing a turn each. The release now leaves the claim standing:
    // host_pod moves only on a handoff, A -> B, never through "nobody".
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-1" });
    const errors: unknown[] = [];
    const a = fencedStore(db, "host-1");
    const b = fencedStore(db, "host-2");
    a.onAppendError((_id, e) => errors.push(e));
    b.onAppendError((_id, e) => errors.push(e));

    // Both hold a head seeded at seq 0, so both compute seq 1 — the collision shape.
    await Promise.all([
      a.appendEvent(CONV, run(1)[0]).catch(() => {}),
      b.appendEvent(CONV, run(2)[0]).catch(() => {}),
    ]);

    expect(errors, "the fence must refuse the non-owner, not leave it to the PK").toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it("THE CLAIM: the first writer takes an unclaimed row, so the second pod is fenced", async () => {
    // #678's dominant path. The row is created with host_pod null and the controller's
    // assignment lands on a reconcile TICK — 6-10s later in the measured failures. Two pods
    // routed the same conversation inside that window both passed the fence and collided on
    // the PK. Claiming on first append closes it in one statement instead of one tick.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: null }); // created, not yet assigned
    const a = fencedStore(db, "host-1");
    const b = fencedStore(db, "host-2");
    const errors: unknown[] = [];
    a.onAppendError((_id, e) => errors.push(e));
    b.onAppendError((_id, e) => errors.push(e));

    await Promise.all([
      a.appendEvent(CONV, run(1)[0]).catch(() => {}),
      b.appendEvent(CONV, run(2)[0]).catch(() => {}),
    ]);

    expect(errors, "no PK collision — the loser is refused by the fence").toEqual([]);
    expect(rows, "exactly one writer committed").toHaveLength(1);
  });

  it("the claim NEVER steals a row another pod already holds", async () => {
    // `where host_pod is null` is the whole guard. A claim that overwrote an existing owner
    // would hand the conversation to whichever pod appended most recently — the opposite of
    // one-writer-per-conversation.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-1" });

    await fencedStore(db, "host-2").appendEvent(CONV, run(1)[0]);
    expect(rows, "host-2 must not claim its way past the owner").toEqual([]);

    await fencedStore(db, "host-1").appendEvent(CONV, run(2)[0]);
    expect(rows, "the real owner still writes").toHaveLength(1);
  });

  it("an UNCLAIMED row appends — and so does a conversation with no row yet", async () => {
    // Both are the first-turn path. The fence blocks a CONTRADICTION; silence is not one.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: null });
    const s = fencedStore(db, "host-1");

    await s.appendEvent(CONV, run(1)[0]);
    await s.appendEvent("conv-no-row" as SessionId, run(1)[0]); // nothing in conversations

    expect(rows.map((r) => r.conversation_id)).toEqual([CONV, "conv-no-row"]);
  });

  it("THE RELEASE: a row released mid-conversation is RE-CLAIMED on the next append", async () => {
    // The defect the diagnostic caught, verbatim (73a52ba6, e2e full shard 3):
    //
    //   17:09:57.328  fptvw  REFUSED   row=held by 5sdwj      <- fence working
    //   17:10:59.721  5sdwj  COLLIDES  (turn lost)
    //   17:10:59.744         the row:  row=UNHELD             <- released in between
    //
    // A claim attempted once per process cannot recover from that: the row comes back
    // unheld, nobody re-takes it, and an unclaimed row refuses nobody — so every pod that
    // still has a bridge walks through. Re-claiming on EVERY append is what closes it, and
    // it is only safe because the claim and the fence are now one statement.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-1" });
    const a = fencedStore(db, "host-1");
    const b = fencedStore(db, "host-2");
    const errors: unknown[] = [];
    a.onAppendError((_id, e) => errors.push(e));
    b.onAppendError((_id, e) => errors.push(e));

    await a.appendEvent(CONV, run(1)[0]);
    assign(CONV, { hostPod: null }); // released mid-conversation

    // b gets there first this time and re-claims; a must now be refused rather than
    // writing alongside it.
    await b.appendEvent(CONV, run(2)[0]);
    await a.appendEvent(CONV, run(3)[0]);

    expect(errors, "the loser is refused by the fence, not left to the PK").toEqual([]);
    expect(rows.map((r) => r.seq), "exactly one writer got through after the release").toEqual([1, 2]);
  });

  it("THE HANDOFF: the incoming owner takes the fence, so its first turn is not dropped", async () => {
    // The window CI caught on this branch (e2e full shard 1, run 37496402896):
    //
    //   16:51:02.094  n4grw  REFUSED  row=held by gj284
    //   16:51:02.151  controller: assigned -> n4grw      <- 57ms later
    //
    // The controller patches the CR status BEFORE it writes the row, and the CR watch is
    // what tells the new owner it owns the conversation — so it starts appending while the
    // row still names its predecessor, and the append-time claim cannot help because that
    // one only takes an UNHELD row. Every event in the gap is dropped with no error.
    const { db, rows, assign, row } = fakeDb();
    assign(CONV, { hostPod: "host-1", hostGeneration: 1 });
    const a = fencedStore(db, "host-1");
    const b = fencedStore(db, "host-2");

    await b.appendEvent(CONV, run(1)[0]);
    expect(rows, "the gap, reproduced: the new owner is refused by the old claim").toEqual([]);

    expect(await b.claimFence(CONV, 2)).toBe("claimed");
    expect(row(CONV)).toEqual({ hostPod: "host-2", hostGeneration: 2 });

    await b.appendEvent(CONV, run(1)[0]);
    expect(rows, "and now its turn lands").toHaveLength(1);

    await a.appendEvent(CONV, run(2)[0]);
    expect(rows, "the handoff is a MOVE — the old owner is fenced out, not alongside").toHaveLength(1);
  });

  it("a STALE assignment cannot take the row back from a newer owner", async () => {
    // `$gen >= host_generation` is the only thing standing between a lagging watch (or a
    // replayed revive push) and a claim that walks the conversation backwards to a pod the
    // controller has already moved it off. Nothing above this layer enforces it: a k8s Lease
    // is not mutual exclusion, so the database has to.
    const { db, assign, row } = fakeDb();
    assign(CONV, { hostPod: "host-2", hostGeneration: 3 });

    expect(await fencedStore(db, "host-1").claimFence(CONV, 2)).toBe("refused");
    expect(row(CONV), "the newer owner keeps it").toEqual({ hostPod: "host-2", hostGeneration: 3 });
  });

  it("a claim at the CURRENT epoch lands, so a failed first attempt can be retried", async () => {
    // Why `>=` and not `>`: this claim carries the epoch it was ASSIGNED at rather than
    // minting a new one, so under `>` a claim that failed (a Postgres blip, a dropped
    // connection) could never be re-made — the conversation would stay fenced against its
    // own owner until the next reassignment. The holder at that epoch is us; re-asserting
    // it is idempotent. Matches rows.sync_assignments, the same write from the controller.
    const { db, assign, row } = fakeDb();
    assign(CONV, { hostPod: "host-1", hostGeneration: 4 }); // the controller's write got there first

    expect(await fencedStore(db, "host-2").claimFence(CONV, 4)).toBe("claimed");
    expect(row(CONV)).toEqual({ hostPod: "host-2", hostGeneration: 4 });
  });

  it("THE REGAIN: a conversation taken back re-seeds seq, instead of colliding on the PK", async () => {
    // A pod that owned a conversation, lost it, and is given it back still holds a CACHED
    // head from its first stint — while the other pod advanced seq past it. Appending from
    // that head is a duplicate (conversation_id, seq): a lost turn reported as a collision,
    // which is the shape this PR exists to remove. The claim is where the stale head dies.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-1", hostGeneration: 1 });
    const a = fencedStore(db, "host-1");
    const b = fencedStore(db, "host-2");
    const errors: unknown[] = [];
    a.onAppendError((_id, e) => errors.push(e));

    await a.appendEvent(CONV, run(1)[0]); // a's head is now seq 1

    await b.claimFence(CONV, 2);
    await b.appendEvent(CONV, run(2)[0]);
    await b.appendEvent(CONV, run(2)[1]); // table is at seq 3

    await a.claimFence(CONV, 3); // reassigned back
    await a.appendEvent(CONV, run(3)[0]);

    expect(errors, "no PK collision from the stale head").toEqual([]);
    expect(rows.map((r) => r.seq), "it continues the log rather than rewriting seq 2").toEqual([1, 2, 3, 4]);
  });

  it("a claim on a conversation with NO row is refused, and says which of the two it was", async () => {
    // Refused covers two states that need opposite fixes — superseded by a newer epoch, or
    // no row at all — and the UPDATE reports both as rowCount 0. The read-back is what
    // separates them, the same way a refused append's does.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); // warn -> console.error
    try {
      const { db } = fakeDb();
      expect(await fencedStore(db, "host-1").claimFence("conv-no-row" as SessionId, 2)).toBe("refused");

      const line = await awaitLine(errSpy, "fence claim refused");
      expect(line, "a refused claim must be logged at all").toBeDefined();
      // By FIELD, not serialized form — log.ts emits JSON or key=value by environment.
      expect(line).toMatch(/"row":"missing"|\brow=missing\b/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("an UNFENCED store has nothing to claim — single-replica is untouched", async () => {
    // No fence configured is the kube-less dev deployment: one writer by construction, so
    // there is no row to take and the ownership hook must not start writing one.
    const { db, assign, row } = fakeDb();
    assign(CONV, { hostPod: null });

    expect(await store(db).claimFence(CONV, 7)).toBe("unfenced");
    expect(row(CONV), "no claim was written").toEqual({ hostPod: null, hostGeneration: 0 });
  });

  it("A COLLISION names the row too — the one failure where nobody was refused", async () => {
    // Observed on this branch: conversation 0078363a refused pod kz8zq at 16:01:26 (`held`
    // by rhtv6), then took 59 PK collisions FROM kz8zq between 16:01:35 and :41. So the row
    // changed in between — but to what? If it named kz8zq, the other writer should have
    // been refused and was not. If it named NOBODY, the claim was released and never
    // re-ran. Opposite fixes, and the refusal log cannot distinguish them, because a
    // collision is exactly the case where no refusal happened. Why: PR #679.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { db, assign } = fakeDb();
      assign(CONV, { hostPod: "host-1" });
      const s = fencedStore(db, "host-1");
      await s.appendEvent(CONV, run(1)[0]); // seq 1 committed

      // A second writer takes seq 2 while this pod's head still says 1. It gets in because
      // the row was RELEASED: an unclaimed row refuses nobody, and host-2's claim takes it.
      assign(CONV, { hostPod: null });
      const other = fencedStore(db, "host-2");
      await other.appendEvent(CONV, run(2)[0]);

      // Released again, so host-1's next append re-claims and is allowed — onto a seq that
      // is already taken. Note what the read-back then reports: `held` by host-1 ITSELF,
      // because the claim that let it through is the same statement as the insert. That is
      // the collision shape that survives the atomic claim, and it is a STALE HEAD, not a
      // second live writer.
      assign(CONV, { hostPod: null });
      await s.appendEvent(CONV, run(3)[0]).catch(() => {}); // collides on (CONV, 2)

      const line = await awaitLine(errSpy, "the row at the moment of a PK collision");
      expect(line, "the collision must be logged").toBeDefined();
      const field = (k: string, v: string) => new RegExp(`"${k}":"?${v}"?|\\b${k}=${v}\\b`);
      expect(line, "flagged as a second writer, not a generic db error").toMatch(field("collided", "true"));
      expect(line, "the row state at the moment of the collision is the whole point").toMatch(
        field("row", "held"),
      );
      expect(line, "named, so held-by-us reads differently from held-by-another").toMatch(
        field("host_pod", "host-1"),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("THE REASON: a refusal names WHY, because held and missing need different fixes", async () => {
    // The predicate rides the insert, so a refusal comes back as rowCount 0 and carries
    // nothing. Both causes then log the same line — and they are not the same event:
    // `held` is the fence working, `missing` is a row that was deleted out from under a
    // live conversation, which under a fence that requires the row is a DROPPED turn.
    // Told apart only by reading the row back, so this pins the read-back. Why: PR #679.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); // warn -> console.error
    try {
      const { db, assign } = fakeDb();
      assign(CONV, { hostPod: "host-2" });
      await fencedStore(db, "host-1").appendEvent(CONV, run(1)[0]);

      const line = await awaitLine(errSpy, "append fenced");
      expect(line, "a refusal must be logged at all").toBeDefined();
      // Matched by FIELD, not by serialized form: log.ts emits JSON (`"row":"held"`) or
      // key=value (`row=held`) depending on the environment, and a test pinned to one of
      // them passes locally and fails in CI on formatting rather than on behaviour.
      const field = (k: string, v: string) => new RegExp(`"${k}":"${v}"|\\b${k}=${v}\\b`);
      expect(line).toMatch(field("row", "held"));
      expect(line, "which pod holds it is the reassignment story").toMatch(field("host_pod", "host-2"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("the fence reads pod identity ONLY — it never consults the epoch", async () => {
    // The fence used to also refuse this pod at a different host_generation, to catch a
    // StatefulSet pod that reused its name. agent-host is a Deployment: a pod name carries a
    // ReplicaSet hash and a random suffix and is never reused, so the epoch clause could only
    // ever refuse a rightful owner whose cached generation lagged the row.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "host-1" });
    await fencedStore(db, "host-1").appendEvent(CONV, run(1)[0]);
    expect(rows, "the named host -> allowed").toHaveLength(1);

    assign(CONV, { hostPod: "host-2" });
    await fencedStore(db, "host-1").appendEvent(CONV, run(2)[0]);
    expect(rows, "a different host -> refused").toHaveLength(1);
  });

  it("an UNFENCED store appends unconditionally — single-replica is untouched", async () => {
    // No POD_NAME means no second writer to fence against and nothing assigning a host, so
    // the fence would refuse nothing and cost a subquery per streamed token.
    const { db, rows, assign } = fakeDb();
    assign(CONV, { hostPod: "someone-else" });

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

describe("eventStore — the tail bounded by EVENT COUNT", () => {
  // `runs` is a poor proxy for size: a turn with 40 tool calls emits hundreds of
  // events, so runs=8 returned 4787 events / 1.3 MB on a real conversation — 53% of
  // its whole log — for what is meant to be a fast first paint.
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
    // Direct trimToBoundary tests do not prove the STORE calls it; without this,
    // deleting the call passes every test while the window folds to nothing.
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
    // A raw seq cut lands mid-item — measured on a real conversation, the first event
    // of a 300-event window was a TOOL_CALL_RESULT whose START was outside it. The
    // client's fold discards such a window, wasting the seed entirely.
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
