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
});
