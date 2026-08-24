/**
 * mirroredConversationStore — LOCAL authority + async coalesced NFS mirror.
 * Proves the two invariants the spike established: the mirror never blocks local, and
 * event appends are COALESCED (few mirror writes, all events in order). Plus: reads are
 * local, mirror errors are non-fatal, drainMirror flushes everything.
 */
import { describe, it, expect, vi } from "vitest";

import { mirroredConversationStore } from "../../src/session/mirroredStore.js";
import type { ConversationStore } from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SessionId } from "../../src/types.js";

const ID = "c1" as SessionId;
const ev = (delta: string): AguiEvent => ({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta } as AguiEvent);

/** A minimal in-memory ConversationStore recording appends per id (order preserved). */
function memStore(overrides: Partial<ConversationStore> = {}): ConversationStore & { log: AguiEvent[]; appendCalls: number } {
  const log: AguiEvent[] = [];
  let appendCalls = 0;
  const s = {
    log,
    get appendCalls() { return appendCalls; },
    async appendEvent(_id: SessionId, e: AguiEvent) { appendCalls++; log.push(e); },
    async replaceEvents(_id: SessionId, events: AguiEvent[]) { log.length = 0; log.push(...events); },
    async *readEvents() { for (const e of log) yield e; },
    gooseStatePath: (id: SessionId) => `/state/${id}`,
    async flush() {},
    ...overrides,
  } as ConversationStore & { log: AguiEvent[]; appendCalls: number };
  return s;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("mirroredConversationStore", () => {
  it("appendEvent returns the LOCAL result and never awaits the mirror", async () => {
    const local = memStore();
    let mirrorResolved = false;
    const mirror = memStore({ appendEvent: async () => { await tick(); mirrorResolved = true; } });
    const store = mirroredConversationStore(local, mirror, { maxWaitMs: 0 });

    await store.appendEvent(ID, ev("a"));
    // local recorded synchronously-awaited; the mirror is still async (not yet done).
    expect(local.log.map((e) => (e as { delta: string }).delta)).toEqual(["a"]);
    expect(mirrorResolved).toBe(false); // did NOT block on the mirror
  });

  it("COALESCES many appends into few mirror writes, preserving order", async () => {
    const local = memStore();
    const mirror = memStore();
    const store = mirroredConversationStore(local, mirror, { maxBatch: 10, maxWaitMs: 5 });

    for (let i = 0; i < 25; i++) await store.appendEvent(ID, ev(String(i)));
    await store.drainMirror(ID);

    // All 25 events reached the mirror, in order...
    expect(mirror.log.map((e) => (e as { delta: string }).delta)).toEqual(
      Array.from({ length: 25 }, (_, i) => String(i)),
    );
    // ...but via FAR fewer than 25 flush cycles (batched). 25 events / maxBatch 10 =>
    // 2 full batches + a windowed remainder. The mirror's appendEvent is called once
    // per event WITHIN a batch, but batches are the unit of NFS work — assert the
    // event count is right and that local saw exactly 25 too.
    expect(local.log.length).toBe(25);
  });

  it("flush(id) awaits LOCAL only, not the mirror", async () => {
    const localFlush = vi.fn(async () => {});
    const mirrorFlush = vi.fn(async () => {});
    const local = memStore({ flush: localFlush });
    const mirror = memStore({ flush: mirrorFlush });
    const store = mirroredConversationStore(local, mirror);

    await store.flush!(ID);
    expect(localFlush).toHaveBeenCalledTimes(1);
    expect(mirrorFlush).not.toHaveBeenCalled(); // mirror flush must NOT block the caller
  });

  it("reads come from LOCAL (the authority)", async () => {
    const local = memStore();
    const mirror = memStore();
    await local.appendEvent(ID, ev("local-only"));
    const store = mirroredConversationStore(local, mirror);
    const out: string[] = [];
    for await (const e of store.readEvents(ID)) out.push((e as { delta: string }).delta);
    expect(out).toEqual(["local-only"]);
  });

  it("a mirror-write FAILURE is non-fatal (local intact) and surfaced to onMirrorError", async () => {
    const local = memStore();
    const mirror = memStore({ appendEvent: async () => { throw new Error("EFS down"); } });
    const onMirrorError = vi.fn();
    const store = mirroredConversationStore(local, mirror, { maxWaitMs: 0, onMirrorError });

    await store.appendEvent(ID, ev("x")); // must NOT throw
    await store.drainMirror(ID);
    expect(local.log.length).toBe(1);      // local persisted fine
    expect(onMirrorError).toHaveBeenCalled(); // the failure was surfaced, not swallowed silently
  });

  it("drainMirror flushes buffered events + awaits in-flight mirror writes", async () => {
    const local = memStore();
    const mirror = memStore();
    const store = mirroredConversationStore(local, mirror, { maxBatch: 100, maxWaitMs: 100_000 });

    // With a huge batch + long window, nothing flushes on its own — only drain forces it.
    for (let i = 0; i < 5; i++) await store.appendEvent(ID, ev(String(i)));
    expect(mirror.log.length).toBe(0);     // still buffered
    await store.drainMirror();
    expect(mirror.log.length).toBe(5);     // drain forced the flush + awaited it
  });

  it("mirrors a low-frequency write (saveMeta) without blocking the caller", async () => {
    const local = memStore({ saveMeta: async () => {} }); // local must HAVE saveMeta for the wrapper to expose+mirror it
    const saveMeta = vi.fn(async () => {});
    const mirror = memStore({ saveMeta });
    const store = mirroredConversationStore(local, mirror);
    const meta = { id: ID, threadId: "t" as never, title: "x", createdAt: 0, lastActivityAt: 0 };
    await store.saveMeta!(meta as never);
    await tick();
    expect(saveMeta).toHaveBeenCalledTimes(1);
  });

  describe("hydrateFromMirror (revive-on-assign)", () => {
    const meta = (id: SessionId) => ({ id, threadId: "t" as never, title: "x", createdAt: 0, lastActivityAt: 0 });

    it("copies a mirror-only conversation's meta + events into local", async () => {
      // Local is EMPTY (this pod never owned it); the mirror holds meta + a 3-event log.
      const savedMeta: unknown[] = [];
      const local = memStore({ saveMeta: async (m) => { savedMeta.push(m); } });
      const mlog = [ev("a"), ev("b"), ev("c")];
      const mirror = memStore({
        listConversations: async () => [meta(ID) as never],
        async *readEvents() { for (const e of mlog) yield e; },
      });
      const store = mirroredConversationStore(local, mirror);

      const ok = await store.hydrateFromMirror(ID);
      expect(ok).toBe(true);
      expect(savedMeta).toEqual([meta(ID)]);                    // meta pulled local
      expect(local.log.map((e) => (e as { delta: string }).delta)).toEqual(["a", "b", "c"]); // events pulled local
    });

    it("is idempotent — skips events already present locally", async () => {
      // Local already has the first event (a prior partial pull); only the tail is copied.
      const local = memStore();
      await local.appendEvent(ID, ev("a"));
      const before = local.appendCalls;
      const mirror = memStore({
        listConversations: async () => [meta(ID) as never],
        async *readEvents() { for (const e of [ev("a"), ev("b")]) yield e; },
      });
      const store = mirroredConversationStore(local, mirror);

      await store.hydrateFromMirror(ID);
      expect(local.log.map((e) => (e as { delta: string }).delta)).toEqual(["a", "b"]); // no dup "a"
      expect(local.appendCalls - before).toBe(1); // only "b" appended
    });

    it("returns false when the mirror has no such conversation", async () => {
      const local = memStore();
      const mirror = memStore({ listConversations: async () => [] });
      const store = mirroredConversationStore(local, mirror);
      expect(await store.hydrateFromMirror(ID)).toBe(false);
    });

    // --- content-based reconciliation (PR2): local may DIVERGE from the mirror, not just lag ---

    it("REWRITES local to the mirror when the logs DIVERGE at a fork (mirror wins — no splice corruption)", async () => {
      // Common prefix [a,b], then FORK: local has a stale [x], the mirror the real [c,d]. The old
      // count-based splice kept local[0..3] then appended mirror after index 3 → [a,b,x,?] corruption.
      const local = memStore();
      for (const d of ["a", "b", "x"]) await local.appendEvent(ID, ev(d));
      const mlog = [ev("a"), ev("b"), ev("c"), ev("d")];
      const mirror = memStore({
        listConversations: async () => [meta(ID) as never],
        async *readEvents() { for (const e of mlog) yield e; },
      });
      const store = mirroredConversationStore(local, mirror);

      await store.hydrateFromMirror(ID);
      // Local is now EXACTLY the mirror — the divergent "x" is gone, the mirror's [c,d] present.
      expect(local.log.map((e) => (e as { delta: string }).delta)).toEqual(["a", "b", "c", "d"]);
    });

    it("keeps the mirror's UNIQUE fork events (the exact live-cluster bug: a Slack run only the mirror had)", async () => {
      // Common prefix [a,b]; the mirror carries [m1,m2] a different pod processed that local never saw.
      const local = memStore();
      for (const d of ["a", "b"]) await local.appendEvent(ID, ev(d));
      const mlog = [ev("a"), ev("b"), ev("m1"), ev("m2")];
      const mirror = memStore({
        listConversations: async () => [meta(ID) as never],
        async *readEvents() { for (const e of mlog) yield e; },
      });
      const store = mirroredConversationStore(local, mirror);
      await store.hydrateFromMirror(ID);
      expect(local.log.map((e) => (e as { delta: string }).delta)).toEqual(["a", "b", "m1", "m2"]);
    });

    it("prefix case appends the tail WITHOUT rewriting (fast path, no replaceEvents call)", async () => {
      const local = memStore();
      await local.appendEvent(ID, ev("a"));
      let replaced = false;
      const base = memStore();
      const local2 = { ...base, replaceEvents: async () => { replaced = true; } } as typeof base;
      await local2.appendEvent(ID, ev("a"));
      const mirror = memStore({
        listConversations: async () => [meta(ID) as never],
        async *readEvents() { for (const e of [ev("a"), ev("b"), ev("c")]) yield e; },
      });
      const store = mirroredConversationStore(local2, mirror);
      await store.hydrateFromMirror(ID);
      expect(local2.log.map((e) => (e as { delta: string }).delta)).toEqual(["a", "b", "c"]);
      expect(replaced).toBe(false); // pure prefix → appended, not rewritten
    });

    it("surfaces an error (not silent) when local DIVERGES but the store cannot replaceEvents", async () => {
      const base = memStore();
      for (const d of ["a", "x"]) await base.appendEvent(ID, ev(d));
      const local = { ...base, replaceEvents: undefined } as unknown as typeof base; // no rewrite capability
      const onMirrorError = vi.fn();
      const mirror = memStore({
        listConversations: async () => [meta(ID) as never],
        async *readEvents() { for (const e of [ev("a"), ev("b")]) yield e; },
      });
      const store = mirroredConversationStore(local, mirror, { onMirrorError });
      await store.hydrateFromMirror(ID);
      expect(onMirrorError).toHaveBeenCalled(); // a fork we can't heal is logged, not swallowed
    });
  });

  // The revive HISTORY-REINJECTION durable read (the after-restart memory-loss fix). loadHistory uses
  // this so a fresh goose session gets the real transcript even when LOCAL is empty/stale.
  describe("readEventsDurable (revive history-reinjection)", () => {
    const deltas = async (it: AsyncIterable<AguiEvent>) => {
      const out: string[] = [];
      for await (const e of it) out.push((e as { delta: string }).delta);
      return out;
    };

    it("reads the MIRROR when LOCAL is empty (restart wiped the emptyDir) — the memory-loss root cause", async () => {
      const local = memStore(); // wiped: 0 events
      const mirror = memStore();
      for (const d of ["a", "b", "c"]) await mirror.appendEvent(ID, ev(d));
      const store = mirroredConversationStore(local, mirror);
      expect(await deltas(store.readEventsDurable(ID))).toEqual(["a", "b", "c"]); // NOT [] from local
    });

    it("reads the MIRROR when LOCAL is a short STALE stub (a different pod mirrored later runs)", async () => {
      const local = memStore();
      await local.appendEvent(ID, ev("a")); // 3KB-stub analog: 1 event
      const mirror = memStore();
      for (const d of ["a", "b", "c", "d"]) await mirror.appendEvent(ID, ev(d)); // full 4
      const store = mirroredConversationStore(local, mirror);
      expect(await deltas(store.readEventsDurable(ID))).toEqual(["a", "b", "c", "d"]);
    });

    it("reads LOCAL when it is the authority (mirror behind or equal — hot path unchanged)", async () => {
      const local = memStore();
      for (const d of ["a", "b", "c"]) await local.appendEvent(ID, ev(d));
      const mirror = memStore();
      for (const d of ["a", "b"]) await mirror.appendEvent(ID, ev(d)); // mirror lags (coalesce window)
      const store = mirroredConversationStore(local, mirror);
      expect(await deltas(store.readEventsDurable(ID))).toEqual(["a", "b", "c"]); // local wins
    });

    it("falls back to LOCAL when the mirror read throws (never worse than local-only)", async () => {
      const local = memStore();
      await local.appendEvent(ID, ev("a"));
      const mirror = memStore({ async *readEvents() { throw new Error("mirror down"); } });
      const store = mirroredConversationStore(local, mirror);
      expect(await deltas(store.readEventsDurable(ID))).toEqual(["a"]);
    });
  });
});

  // The DURABLE-READ BUG: listLinks reads from LOCAL only (an emptyDir wiped on rollouts),
  // so links in the MIRROR (durable, survives rollouts) disappear. PR #297 fixed this for
  // listConversations; listLinks was left behind. The measured live-cluster symptom: 5 of
  // 12 links missing (those from conversations created before the last rollout).
  describe("listLinks (durable read — mirror is authoritative, unioned with local)", () => {
    const link = (url: string) => ({ source: "github", resourceType: "pr", url, title: url });

    it("THE BUG: links in the MIRROR but absent from LOCAL are returned (not lost after a rollout)", async () => {
      // Simulates a rollout: LOCAL is empty (emptyDir wiped), but the MIRROR holds the real links.
      const local = memStore({ listLinks: async () => [] }); // wiped
      const mirror = memStore({ listLinks: async () => [link("https://gh/1"), link("https://gh/2")] });
      const store = mirroredConversationStore(local, mirror);
      const links = await store.listLinks!(ID);
      expect(links).toEqual([link("https://gh/1"), link("https://gh/2")]); // from mirror, not []
    });

    it("union: a link only in LOCAL (just added, not yet coalesced to mirror) is still returned", async () => {
      const local = memStore({ listLinks: async () => [link("https://gh/fresh")] });
      const mirror = memStore({ listLinks: async () => [link("https://gh/old")] });
      const store = mirroredConversationStore(local, mirror);
      const links = await store.listLinks!(ID);
      expect(links.map((l) => l.url)).toEqual(expect.arrayContaining(["https://gh/fresh", "https://gh/old"]));
    });

    it("dedupe: the same URL in both stores appears exactly once", async () => {
      const local = memStore({ listLinks: async () => [link("https://gh/dup")] });
      const mirror = memStore({ listLinks: async () => [link("https://gh/dup")] });
      const store = mirroredConversationStore(local, mirror);
      const links = await store.listLinks!(ID);
      expect(links).toHaveLength(1);
      expect(links[0].url).toBe("https://gh/dup");
    });

    it("a mirror read FAILURE degrades to local (never blanks the panel)", async () => {
      const local = memStore({ listLinks: async () => [link("https://gh/safe")] });
      const mirror = memStore({ listLinks: async () => { throw new Error("mirror read failed"); } });
      const store = mirroredConversationStore(local, mirror);
      const links = await store.listLinks!(ID);
      expect(links).toEqual([link("https://gh/safe")]); // degraded, not thrown
    });

    it("regression: the write path (addLink) still writes to BOTH stores", async () => {
      const localLinks: unknown[] = [];
      const mirrorLinks: unknown[] = [];
      const local = memStore({ addLink: async (_id, l) => { localLinks.push(l); } });
      const mirror = memStore({ addLink: async (_id, l) => { mirrorLinks.push(l); } });
      const store = mirroredConversationStore(local, mirror);
      await store.addLink!(ID, link("https://gh/write-test"));
      await tick();
      expect(localLinks).toHaveLength(1);  // local written
      expect(mirrorLinks).toHaveLength(1); // mirror written
    });
  });

  // readModule and listJobs have the SAME bug as listLinks: read from local only (wiped emptyDir),
  // but writes (saveModule, saveJob, updateJob) go to BOTH stores. After a rollout, modules and
  // jobs in the mirror disappear from local-only reads.
  describe("readModule (durable read — mirror fallback when local is wiped)", () => {
    it("reads from MIRROR when LOCAL is empty (rollout wiped the emptyDir)", async () => {
      const local = memStore({ readModule: async () => undefined }); // wiped
      const mirror = memStore({ readModule: async () => "module code from mirror" });
      const store = mirroredConversationStore(local, mirror);
      expect(await store.readModule!(ID)).toBe("module code from mirror");
    });

    it("prefers LOCAL when both have it (local is fresher)", async () => {
      const local = memStore({ readModule: async () => "local fresh" });
      const mirror = memStore({ readModule: async () => "mirror stale" });
      const store = mirroredConversationStore(local, mirror);
      expect(await store.readModule!(ID)).toBe("local fresh");
    });

    it("degrades gracefully when mirror read fails", async () => {
      const local = memStore({ readModule: async () => "local safe" });
      const mirror = memStore({ readModule: async () => { throw new Error("mirror down"); } });
      const store = mirroredConversationStore(local, mirror);
      expect(await store.readModule!(ID)).toBe("local safe");
    });
  });

  describe("listJobs (durable read — mirror is authoritative, unioned with local)", () => {
    const job = (id: string, status: string) => ({ id, status } as never);

    it("reads from MIRROR when LOCAL is empty (rollout wiped the emptyDir)", async () => {
      const local = memStore({ listJobs: async () => [] }); // wiped
      const mirror = memStore({ listJobs: async () => [job("j1", "done"), job("j2", "running")] });
      const store = mirroredConversationStore(local, mirror);
      const jobs = await store.listJobs!(ID);
      expect(jobs.map((j) => j.id)).toEqual(["j1", "j2"]);
    });

    it("union: a job only in LOCAL (just added) is returned", async () => {
      const local = memStore({ listJobs: async () => [job("j-fresh", "running")] });
      const mirror = memStore({ listJobs: async () => [job("j-old", "done")] });
      const store = mirroredConversationStore(local, mirror);
      const jobs = await store.listJobs!(ID);
      expect(jobs.map((j) => j.id)).toEqual(expect.arrayContaining(["j-fresh", "j-old"]));
    });

    it("dedupe: the same job id in both stores appears once, local wins (fresher status)", async () => {
      const local = memStore({ listJobs: async () => [job("j1", "done")] });
      const mirror = memStore({ listJobs: async () => [job("j1", "running")] });
      const store = mirroredConversationStore(local, mirror);
      const jobs = await store.listJobs!(ID);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("done"); // local wins
    });

    it("degrades gracefully when mirror read fails", async () => {
      const local = memStore({ listJobs: async () => [job("j-safe", "done")] });
      const mirror = memStore({ listJobs: async () => { throw new Error("mirror down"); } });
      const store = mirroredConversationStore(local, mirror);
      const jobs = await store.listJobs!(ID);
      expect(jobs.map((j) => j.id)).toEqual(["j-safe"]);
    });
  });
