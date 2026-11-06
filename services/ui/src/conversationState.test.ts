// The state feed and the topic reader built on it.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { watchTopic, type TopicOptions } from "./conversationState.js";
import { createStateFeed, type StateFeed } from "./stateFeed.js";

/** Follow a topic, recording its values and fallback poll starts and stops. */
function follow<T>(feed: StateFeed, topic: string, opts: TopicOptions<T> = {}) {
  const values: T[] = [];
  const polls: string[] = [];
  const stop = watchTopic<T>(
    feed,
    "c1",
    topic,
    () => opts,
    (v) => void values.push(v),
    () => {
      polls.push("start");
      return () => void polls.push("stop");
    },
  );
  return { values, polls, stop };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("state feed", () => {
  it("drops a conversation once it has neither readers nor a stream", () => {
    const feed = createStateFeed();
    const a = follow(feed, "sandbox");
    feed.open("c1");
    a.stop();
    expect(feed.size()).toBe(1);
    feed.down("c1");
    expect(feed.size()).toBe(0);
  });

  it("delivers a pushed value to its topic only, and gives a late reader the kept value", () => {
    const feed = createStateFeed();
    const sandbox = follow<{ ready: boolean }>(feed, "sandbox");
    const shares = follow(feed, "contrib:shares");
    feed.open("c1");
    feed.frame("c1", { kind: "topic", topic: "sandbox", data: { ready: true } });
    feed.frame("c2", { kind: "topic", topic: "sandbox", data: { ready: false } });
    expect(sandbox.values).toEqual([{ ready: true }]);
    expect(shares.values).toEqual([]);

    const late = follow<{ ready: boolean }>(feed, "sandbox");
    expect(late.values).toEqual([{ ready: true }]);
    for (const r of [sandbox, shares, late]) r.stop();
  });

  it("re-runs the loader on an invalidation", async () => {
    const feed = createStateFeed();
    let n = 0;
    const r = follow<number>(feed, "contrib:shares", { load: async () => ++n });
    feed.open("c1");
    await settle();
    const before = n;
    feed.frame("c1", { kind: "topic", topic: "contrib:shares" });
    await settle();
    expect(n).toBe(before + 1);
    expect(r.values.at(-1)).toBe(n);
    r.stop();
  });

  it("does not let a slow load overwrite a newer pushed value", async () => {
    const feed = createStateFeed();
    const pending: ((v: string) => void)[] = [];
    const r = follow<string>(feed, "contrib:x", { load: () => new Promise<string>((res) => pending.push(res)) });
    feed.open("c1");
    feed.frame("c1", { kind: "topic", topic: "contrib:x", data: "pushed" });
    for (const release of pending) release("stale");
    await settle();
    expect(r.values).toEqual(["pushed"]);
    r.stop();
  });

  it("polls while no stream is synced, and reloads when one is", async () => {
    const feed = createStateFeed();
    let n = 0;
    const r = follow<number>(feed, "contrib:shares", { load: async () => ++n, fallbackPollMs: 10_000 });
    // Before any stream it reads once and arms the poll.
    expect(r.polls).toEqual(["start"]);
    feed.open("c1");
    // A second stream (another agent in the tab) must not double-count.
    feed.open("c1");
    expect(r.polls).toEqual(["start", "stop"]);
    await settle();
    const before = n;

    feed.down("c1");
    expect(r.polls.at(-1), "one stream is still up").toBe("stop");
    feed.down("c1");
    expect(r.polls.at(-1)).toBe("start");

    feed.open("c1");
    await settle();
    expect(r.polls.at(-1)).toBe("stop");
    expect(n, "frames sent while down are gone, so a reconnect reloads").toBeGreaterThan(before);
    r.stop();
  });
});
