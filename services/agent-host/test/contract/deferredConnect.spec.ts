/**
 * Tier 1 contract test — the deferred-connect in-flight dedupe.
 *
 * The sandbox exec client connects lazily on first use. A BURST of concurrent
 * first tool calls (goose firing several at once) must trigger exactly ONE
 * connect — not N (each of which polls for pod readiness up to 90s). The bug:
 * `real ??= await connect()` caches the RESOLVED value, so concurrent awaits all
 * miss the cache and each run connect. Fix: memoize the PROMISE.
 */

import { describe, it, expect, vi } from "vitest";

import { createDeferredConnector } from "../../src/exec/deferredConnect.js";

describe("deferred connect — in-flight dedupe", () => {
  it("a burst of concurrent first uses connects exactly ONCE", async () => {
    let resolveConnect: (v: { tag: string }) => void;
    const connect = vi.fn(
      () => new Promise<{ tag: string }>((r) => (resolveConnect = r)),
    );
    const ensure = createDeferredConnector(connect);

    // 5 concurrent first calls, BEFORE the connect resolves.
    const calls = Promise.all([ensure(), ensure(), ensure(), ensure(), ensure()]);
    // connect must have been started exactly once (the in-flight promise shared).
    expect(connect).toHaveBeenCalledTimes(1);

    resolveConnect!({ tag: "client" });
    const results = await calls;
    // All callers got the same resolved client.
    expect(results.every((r) => r.tag === "client")).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reuses the resolved client on later calls (no reconnect)", async () => {
    const connect = vi.fn(async () => ({ tag: "client" }));
    const ensure = createDeferredConnector(connect);
    await ensure();
    await ensure();
    await ensure();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("a failed connect is NOT cached — the next call retries", async () => {
    let n = 0;
    const connect = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("pod not ready");
      return { tag: "client" };
    });
    const ensure = createDeferredConnector(connect);

    await expect(ensure()).rejects.toThrow("pod not ready");
    // The failure must clear the in-flight promise so a retry actually reconnects.
    const ok = await ensure();
    expect(ok.tag).toBe("client");
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
