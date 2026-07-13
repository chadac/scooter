/**
 * Tier 1 contract test — the ownership lease (sharding stage 0, the load-bearing
 * correctness primitive). At most ONE shard owns a conversation at a time, and a
 * superseded owner is FENCED. With shard-local event seq, this is what prevents
 * double-goose / colliding seqs. See docs/AGENT_HOST_SHARDING.md.
 *
 * Runs against the in-memory reference impl with an injectable clock. The Postgres
 * impl must satisfy the SAME assertions (a shared harness would parametrize both;
 * kept on the in-mem impl here for hermeticity).
 */

import { describe, it, expect } from "vitest";

import { createInMemoryLease } from "../../src/shard/inMemoryLease.js";

// A controllable clock so expiry is deterministic.
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const TTL = 30_000;

describe("ownership lease", () => {
  it("acquire grants an unowned conversation and bumps the generation", async () => {
    const lease = createInMemoryLease({ ttlMs: TTL, now: clock().now });
    const g = await lease.acquire("c1", 0);
    expect(g).not.toBeNull();
    expect(g!.ownerOrd).toBe(0);
    expect(g!.generation).toBe(1); // first grant
  });

  it("a second shard CANNOT acquire while a live lease is held", async () => {
    const lease = createInMemoryLease({ ttlMs: TTL, now: clock().now });
    await lease.acquire("c1", 0);
    const other = await lease.acquire("c1", 1);
    expect(other).toBeNull(); // fenced out
  });

  it("re-acquire by the SAME owner is idempotent (extends, same owner, new gen)", async () => {
    const lease = createInMemoryLease({ ttlMs: TTL, now: clock().now });
    const a = await lease.acquire("c1", 0);
    const b = await lease.acquire("c1", 0);
    expect(b).not.toBeNull();
    expect(b!.ownerOrd).toBe(0);
    expect(b!.generation).toBeGreaterThan(a!.generation);
  });

  it("an EXPIRED lease is free for another shard to acquire", async () => {
    const c = clock();
    const lease = createInMemoryLease({ ttlMs: TTL, now: c.now });
    await lease.acquire("c1", 0);
    c.advance(TTL + 1); // lease lapses (shard 0 died without renewing)
    const other = await lease.acquire("c1", 1);
    expect(other).not.toBeNull();
    expect(other!.ownerOrd).toBe(1);
  });

  it("holds() is true for the current holder, false once superseded", async () => {
    const lease = createInMemoryLease({ ttlMs: TTL, now: clock().now });
    const a = await lease.acquire("c1", 0);
    expect(await lease.holds("c1", 0, a!.generation)).toBe(true);
    // Another shard steals it (drain/rebalance/dead-shard) -> generation bumps.
    await lease.steal("c1", 1);
    // The old owner is now FENCED — must not spawn goose / append.
    expect(await lease.holds("c1", 0, a!.generation)).toBe(false);
  });

  it("renew extends the current holder but is REJECTED for a superseded generation", async () => {
    const c = clock();
    const lease = createInMemoryLease({ ttlMs: TTL, now: c.now });
    const a = await lease.acquire("c1", 0);
    c.advance(TTL / 2);
    const renewed = await lease.renew("c1", 0, a!.generation);
    expect(renewed).not.toBeNull();
    expect(renewed!.expiresAt).toBeGreaterThan(a!.expiresAt); // extended

    // A steal supersedes gen; the old owner's renew must be fenced.
    const stolen = await lease.steal("c1", 1);
    expect(await lease.renew("c1", 0, a!.generation)).toBeNull();
    // The new owner renews fine.
    expect(await lease.renew("c1", 1, stolen.generation)).not.toBeNull();
  });

  it("steal ALWAYS grants and fences the previous owner (dead-shard reassignment)", async () => {
    const lease = createInMemoryLease({ ttlMs: TTL, now: clock().now });
    const a = await lease.acquire("c1", 0);
    const stolen = await lease.steal("c1", 2);
    expect(stolen.ownerOrd).toBe(2);
    expect(stolen.generation).toBeGreaterThan(a!.generation);
    expect(await lease.holds("c1", 0, a!.generation)).toBe(false); // old owner fenced
    expect(await lease.holds("c1", 2, stolen.generation)).toBe(true);
  });

  it("release frees the conversation only if you hold the current generation", async () => {
    const lease = createInMemoryLease({ ttlMs: TTL, now: clock().now });
    const a = await lease.acquire("c1", 0);
    // A stale holder's release is a no-op (doesn't free someone else's lease).
    await lease.steal("c1", 1);
    await lease.release("c1", 0, a!.generation); // stale -> no-op
    expect(await lease.acquire("c1", 3)).toBeNull(); // shard 1 still holds it

    // The real holder releases -> now acquirable.
    const held = await lease.acquire("c1", 1); // idempotent re-acquire to learn gen
    await lease.release("c1", 1, held!.generation);
    expect(await lease.acquire("c1", 3)).not.toBeNull();
  });

  it("two shards racing to acquire: exactly one wins", async () => {
    const lease = createInMemoryLease({ ttlMs: TTL, now: clock().now });
    const [a, b] = await Promise.all([lease.acquire("c1", 0), lease.acquire("c1", 1)]);
    const winners = [a, b].filter((x) => x !== null);
    expect(winners).toHaveLength(1);
  });
});
