/**
 * Tier 1 contract — the background-job registry lives in Postgres, and a conversation
 * whose jobs exist only in a file registry still lists them.
 *
 * The registry answers "which jobs does this conversation have?" and must survive a
 * rollout. LOCAL_STATE_PATH is an emptyDir that every rollout wipes, and the RWX mirror
 * is write-only for jobs (nothing hydrates them back), so a file-backed registry loses a
 * conversation's jobs whenever the pod moves. These tests run in exactly that shape: the
 * file registry is EMPTY (wiped) and the data is only in the database.
 *
 * Job OUTPUT is not covered here — it lives in-pod on the workspace PVC by design.
 */

import { describe, it, expect, vi } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";

import { createPgJobStore } from "../../src/session/jobStore.js";
import type { JobRecord } from "../../src/session/jobManager.js";

const CONV = "conv-1";
const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  jobId: "j1",
  command: "make build",
  startedAt: 1_000,
  ...over,
});

/**
 * A tiny in-memory Postgres standing UNDER Drizzle: the store now builds its statements
 * with the generated schema, but Drizzle still hands the pool `{text}` + a params array,
 * so the same SQL branching stays under test — conflict semantics included, which is what
 * backfill correctness rests on. Wrapped with drizzle() by `fakeDrizzle` below.
 */
function fakeDb(): { query: (cfg: unknown, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; rows: Map<string, JobRecord>; queries: string[] } {
  const rows = new Map<string, JobRecord>(); // "conv|jobId" -> record
  const queries: string[] = [];
  const key = (c: string, j: string) => `${c}|${j}`;
  return {
    rows,
    queries,
    async query(cfg: unknown, paramsIn: unknown[] = []) {
      // drizzle: query({ text, types }, params). Raw pg: query(sql, params).
      const sql = typeof cfg === "string" ? cfg : ((cfg as { text: string }).text ?? "");
      const params = paramsIn;
      queries.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));

      if (/^INSERT/i.test(sql.trim())) {
        const [c, j, command, startedAt, notifiedAt] = params as [string, string, string, number, number | null];
        const k = key(c, j);
        const exists = rows.has(k);
        const doNothing = /DO NOTHING/i.test(sql);
        if (exists && doNothing) return { rows: [], rowCount: 0 };
        rows.set(k, {
          jobId: j,
          command,
          startedAt,
          ...(notifiedAt == null ? {} : { notifiedAt }),
        });
        return { rows: [], rowCount: 1 };
      }

      if (/^SELECT/i.test(sql.trim())) {
        const [c] = params as [string];
        const out = [...rows.entries()]
          .filter(([k]) => k.startsWith(`${c}|`))
          .map(([, r]) => r)
          .sort((a, b) => b.startedAt - a.startedAt) // ORDER BY started_at DESC
          // drizzle asks for rowMode:"array" — positional values in SELECT order, which
          // it then maps back onto the aliases the query named. bigint comes back as a
          // STRING from node-postgres; the store must coerce.
          .map((r) => [
            r.jobId,
            r.command,
            String(r.startedAt),
            r.notifiedAt == null ? null : String(r.notifiedAt),
          ]);
        return { rows: out, rowCount: out.length };
      }

      if (/^UPDATE/i.test(sql.trim())) {
        // drizzle binds SET values FIRST, then the WHERE terms — the reverse of the
        // hand-written statement this replaced.
        const [command, startedAt, notifiedAt, c, j] = params as [string, number, number | null, string, string];
        const k = key(c, j);
        if (!rows.has(k)) return { rows: [], rowCount: 0 };
        rows.set(k, { jobId: j, command, startedAt, ...(notifiedAt == null ? {} : { notifiedAt }) });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    async end() {},
  };
}

/** The store takes a Drizzle handle; wrap the in-memory pg so the tests drive the real
 *  query builder and the fake still sees the SQL it asserts on. */
const fakeDrizzle = (db: ReturnType<typeof fakeDb>) => drizzle(db as never);

/** A file-backed registry standing in for one a deployment still carries on disk. */
const legacyWith = (jobs: Record<string, JobRecord[]>) => ({
  listJobs: vi.fn(async (id: string) => jobs[id] ?? []),
});

describe("Postgres job registry", () => {
  it("round-trips a job through the database", async () => {
    const db = fakeDb();
    const store = createPgJobStore({ db: fakeDrizzle(db) });

    await store.saveJob(CONV, job());
    expect(await store.listJobs(CONV)).toEqual([job()]);
  });

  it("THE ROLLOUT SHAPE: jobs survive when the file registry is empty", async () => {
    // The pod moved: the local emptyDir is gone, so the legacy registry answers []. The
    // database is the only copy, and it must still list the conversation's jobs.
    const db = fakeDb();
    const legacy = legacyWith({}); // wiped
    const store = createPgJobStore({ db: fakeDrizzle(db), legacy });

    await store.saveJob(CONV, job({ jobId: "j1", startedAt: 1_000 }));
    await store.saveJob(CONV, job({ jobId: "j2", startedAt: 2_000 }));

    const listed = await store.listJobs(CONV);
    expect(listed.map((j) => j.jobId)).toEqual(["j2", "j1"]); // newest first
  });

  it("scopes jobs to their own conversation", async () => {
    const db = fakeDb();
    const store = createPgJobStore({ db: fakeDrizzle(db) });
    await store.saveJob("conv-a", job({ jobId: "ja" }));
    await store.saveJob("conv-b", job({ jobId: "jb" }));

    expect((await store.listJobs("conv-a")).map((j) => j.jobId)).toEqual(["ja"]);
  });

  it("coerces bigint timestamps back to numbers", async () => {
    // node-postgres hands back bigint columns as strings; a JobRecord carries ms-epoch
    // NUMBERS, and the completion watcher does arithmetic on them.
    const db = fakeDb();
    const store = createPgJobStore({ db: fakeDrizzle(db) });
    await store.saveJob(CONV, job({ startedAt: 1_700_000_000_000, notifiedAt: 1_700_000_009_999 }));

    const [got] = await store.listJobs(CONV);
    expect(got.startedAt).toBe(1_700_000_000_000);
    expect(got.notifiedAt).toBe(1_700_000_009_999);
  });

  it("updateJob marks notifiedAt in place", async () => {
    const db = fakeDb();
    const store = createPgJobStore({ db: fakeDrizzle(db) });
    await store.saveJob(CONV, job());
    await store.updateJob!(CONV, job({ notifiedAt: 5_000 }));

    expect((await store.listJobs(CONV))[0].notifiedAt).toBe(5_000);
  });

  it("updateJob does NOT create a row for a job that was never registered", async () => {
    // The watcher marks EXISTING jobs announced. Conjuring a row here would invent a
    // job the conversation never started.
    const db = fakeDb();
    const store = createPgJobStore({ db: fakeDrizzle(db) });
    await store.updateJob!(CONV, job({ jobId: "ghost", notifiedAt: 1 }));

    expect(await store.listJobs(CONV)).toEqual([]);
  });
});

describe("read-through to a legacy file registry", () => {
  it("serves jobs that exist only in the legacy registry", async () => {
    const db = fakeDb();
    const legacy = legacyWith({ [CONV]: [job({ jobId: "old" })] });
    const store = createPgJobStore({ db: fakeDrizzle(db), legacy });

    expect((await store.listJobs(CONV)).map((j) => j.jobId)).toEqual(["old"]);
  });

  it("BACKFILLS them, so the next read is served from the database", async () => {
    const db = fakeDb();
    const legacy = legacyWith({ [CONV]: [job({ jobId: "old" })] });
    const store = createPgJobStore({ db: fakeDrizzle(db), legacy });

    await store.listJobs(CONV); // reads through + backfills
    legacy.listJobs.mockClear();

    const second = await store.listJobs(CONV);
    expect(second.map((j) => j.jobId)).toEqual(["old"]);
    expect(legacy.listJobs).not.toHaveBeenCalled(); // no longer consulted
  });

  it("never lets a backfill overwrite a row the database already has", async () => {
    // A stale legacy notifiedAt must not clobber the live one — that would make the
    // completion watcher announce a job it has already announced.
    const db = fakeDb();
    const legacy = legacyWith({ [CONV]: [job({ jobId: "j1", notifiedAt: undefined })] });
    const store = createPgJobStore({ db: fakeDrizzle(db), legacy });

    await store.saveJob(CONV, job({ jobId: "j1", notifiedAt: 9_000 }));
    const listed = await store.listJobs(CONV);

    expect(listed[0].notifiedAt).toBe(9_000);
  });

  it("does not read through once the conversation has rows in the database", async () => {
    const db = fakeDb();
    const legacy = legacyWith({ [CONV]: [job({ jobId: "old" })] });
    const store = createPgJobStore({ db: fakeDrizzle(db), legacy });

    await store.saveJob(CONV, job({ jobId: "new" }));
    const listed = await store.listJobs(CONV);

    expect(listed.map((j) => j.jobId)).toEqual(["new"]);
    expect(legacy.listJobs).not.toHaveBeenCalled();
  });

  it("updateJob pulls a legacy-only job forward, then applies the mark", async () => {
    // The watcher can announce a job whose conversation has never been listed, so the
    // read-through that would have pulled it forward has not run yet.
    const db = fakeDb();
    const legacy = legacyWith({ [CONV]: [job({ jobId: "old" })] });
    const store = createPgJobStore({ db: fakeDrizzle(db), legacy });

    await store.updateJob!(CONV, job({ jobId: "old", notifiedAt: 4_242 }));

    const listed = await store.listJobs(CONV);
    expect(listed).toHaveLength(1);
    expect(listed[0].notifiedAt).toBe(4_242);
  });
});

describe("database failures degrade, never throw into the agent's turn", () => {
  const brokenDb = () => ({
    query: async () => {
      throw new Error("connection terminated");
    },
    end: async () => {},
  });

  it("saveJob swallows a write failure", async () => {
    const store = createPgJobStore({ db: brokenDb() });
    await expect(store.saveJob(CONV, job())).resolves.toBeUndefined();
  });

  it("listJobs degrades to the legacy registry when the query fails", async () => {
    const legacy = legacyWith({ [CONV]: [job({ jobId: "old" })] });
    const store = createPgJobStore({ db: brokenDb(), legacy });

    expect((await store.listJobs(CONV)).map((j) => j.jobId)).toEqual(["old"]);
  });

  it("listJobs returns [] rather than throwing when everything is down", async () => {
    const store = createPgJobStore({ db: brokenDb() });
    await expect(store.listJobs(CONV)).resolves.toEqual([]);
  });
});
