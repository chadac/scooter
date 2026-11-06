// A server that keeps refusing is backed off, not hammered.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { openSSE } from "./sseClient.js";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("openSSE", () => {
  it("doubles the retry wait per refusal up to the cap", async () => {
    let calls = 0;
    const fetchImpl = (async () => (calls++, new Response("", { status: 404 }))) as unknown as typeof fetch;
    const sub = openSSE("/x", { onFrame: () => {} }, { fetchImpl, retryAfterMs: 20, maxRetryMs: 40 });
    const after = async (ms: number) => (await vi.advanceTimersByTimeAsync(ms), calls);
    expect(await after(0)).toBe(1);
    expect(await after(19)).toBe(1);
    expect(await after(1)).toBe(2); // waited 20
    expect(await after(39)).toBe(2);
    expect(await after(1)).toBe(3); // waited 40
    expect(await after(40)).toBe(4); // held at the 40 cap
    sub.close();
  });

  it("reports open on a 200 and down when that stream ends", async () => {
    const events: string[] = [];
    const fetchImpl = (async () =>
      new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 })) as unknown as typeof fetch;
    const sub = openSSE(
      "/x",
      { onFrame: () => {}, onOpen: () => events.push("open"), onDown: () => events.push("down") },
      { fetchImpl },
    );
    await vi.advanceTimersByTimeAsync(0);
    sub.close();
    expect(events).toEqual(["open", "down"]);
  });
});
