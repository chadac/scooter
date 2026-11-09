import { describe, it, expect } from "vitest";

import { CACHE_SCHEMA_VERSION, createConversationCache, memoryBackend } from "./conversationCache.js";

/** A fold whose JSON is about `n` characters. */
const fold = (n: number) => ({ pad: "x".repeat(Math.max(0, n - 10)) });

function setup(opts: Parameters<typeof createConversationCache>[1] = {}) {
  let t = 1_000;
  const backend = memoryBackend();
  const cache = createConversationCache(backend, { now: () => t, ...opts });
  return { backend, cache, tick: (ms = 1) => (t += ms) };
}

describe("conversationCache", () => {
  it("round-trips a fold for the signed-in user", async () => {
    const { cache } = setup();
    await cache.setUser("u1");
    await cache.save("c1", { cursor: { seq: 3 } });
    expect(await cache.load("c1")).toEqual({ cursor: { seq: 3 } });
    expect(await cache.load("c2")).toBeUndefined();
  });

  it("ignores saves until the user is known", async () => {
    const { cache, backend } = setup();
    await cache.save("c1", fold(10));
    expect(backend.folds.size).toBe(0);
  });

  it("wipes another user's cache", async () => {
    const { cache, backend } = setup();
    await backend.putMeta({ version: CACHE_SCHEMA_VERSION, userId: "someone-else" });
    await backend.putFold({ id: "c1", bytes: 2, openedAt: 0, savedAt: 1_000 }, "{}");
    await cache.setUser("u1");
    expect(await cache.load("c1")).toBeUndefined();
  });

  it("wipes a cache written in an older schema", async () => {
    const { cache, backend } = setup();
    await backend.putMeta({ version: CACHE_SCHEMA_VERSION - 1, userId: "u1" });
    await backend.putFold({ id: "c1", bytes: 2, openedAt: 0, savedAt: 1_000 }, "{}");
    await cache.setUser("u1");
    expect(backend.folds.size).toBe(0);
  });

  it("keeps a cache that is already this user's", async () => {
    const { cache, backend } = setup();
    await backend.putMeta({ version: CACHE_SCHEMA_VERSION, userId: "u1" });
    await backend.putFold({ id: "c1", bytes: 2, openedAt: 0, savedAt: 1_000 }, "{}");
    await cache.setUser("u1");
    expect(await cache.load("c1")).toEqual({});
  });

  it("evicts the least recently opened past the budget, down to the low-water mark", async () => {
    const { cache, backend, tick } = setup({ budget: 300, lowWater: 200 });
    await cache.setUser("u1");
    for (const id of ["a", "b", "c"]) {
      await cache.save(id, fold(100));
      tick();
    }
    // Opening "a" makes "b" the least recently opened.
    await cache.load("a");
    tick();
    await cache.save("d", fold(100));
    // "b" and "c" go; "a" survives though cached first.
    expect([...backend.folds.keys()].sort()).toEqual(["a", "d"]);
  });

  it("does not cache a fold over the per-conversation cap, and drops its stale copy", async () => {
    const { cache, backend } = setup({ maxEntry: 50 });
    await cache.setUser("u1");
    await cache.save("c1", fold(20));
    await cache.save("c1", fold(80));
    expect(backend.folds.has("c1")).toBe(false);
  });

  it("drops folds older than the max age", async () => {
    const { cache, backend, tick } = setup({ maxAge: 100 });
    await cache.setUser("u1");
    await cache.save("old", fold(10));
    tick(500);
    await cache.save("new", fold(10));
    expect([...backend.folds.keys()]).toEqual(["new"]);
  });

  it("forgets a removed conversation", async () => {
    const { cache } = setup();
    await cache.setUser("u1");
    await cache.save("c1", fold(10));
    await cache.remove("c1");
    expect(await cache.load("c1")).toBeUndefined();
  });

  it("waits for the user before reading", async () => {
    const { cache } = setup();
    const pending = cache.load("c1");
    await cache.setUser("u1");
    expect(await pending).toBeUndefined();
  });

  it("treats a failing store as a miss", async () => {
    const backend = memoryBackend();
    backend.getFold = async () => {
      throw new Error("quota");
    };
    const cache = createConversationCache(backend);
    await cache.setUser("u1");
    expect(await cache.load("c1")).toBeUndefined();
  });
});
