/**
 * The render pump resumes a reconnect from its stream cursor: it sends afterSeq/checksum,
 * keeps its fold on `resume`, and re-folds from empty on `reset` or a server that ignores
 * the cursor. A frame that does not chain is dropped and the gap fetched on reconnect.
 */

import { describe, it, expect, vi } from "vitest";

import { createIntegrityAgent } from "./integrityAgent.js";

const sum = (n: number) => n.toString(16).padStart(64, "0");

/** One logged event as the server frames it, with seq and chained checksums. */
const logged = (seq: number, event: Record<string, unknown>) => ({
  kind: "event",
  event,
  seq,
  checksum: sum(seq),
  prevChecksum: sum(seq - 1),
});

const turn = (from: number, id: string, text: string) => [
  logged(from, { type: "RUN_STARTED", threadId: "c1", runId: `r-${id}` }),
  logged(from + 1, { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" }),
  logged(from + 2, { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text }),
  logged(from + 3, { type: "TEXT_MESSAGE_END", messageId: id }),
  logged(from + 4, { type: "RUN_FINISHED", threadId: "c1", runId: `r-${id}` }),
];

const synced = (seq: number) => ({ kind: "synced", seq, checksum: sum(seq) });

/** Serve each connection's frames in turn; the last connection stays open. */
function scriptedFetch(connections: unknown[][]) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/tail")) return new Response(JSON.stringify({ events: [] }), { status: 200 });
    urls.push(url);
    const n = urls.length - 1;
    const frames = connections[Math.min(n, connections.length - 1)];
    const last = n >= connections.length - 1;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
        if (!last) c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const texts = (agent: ReturnType<typeof createIntegrityAgent>) =>
  (agent as unknown as { messages: Array<{ content?: unknown }> }).messages.map((m) => m.content);

async function pump(connections: unknown[][], conns: number) {
  const { fetchImpl, urls } = scriptedFetch(connections);
  const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl, idleReconnectMs: 0 });
  const stop = agent.renderPump();
  await vi.waitFor(() => expect(urls.length).toBe(conns), { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 50));
  return { agent, urls, stop };
}

describe("IntegrityAgent resume", () => {
  it("reports the head cursor from `synced` and ends the replay", async () => {
    const { agent, stop } = await pump([[...turn(1, "a", "one"), synced(5)]], 1);
    expect(agent.streamCursor()).toEqual({ seq: 5, checksum: sum(5) });
    expect(agent.isReplaying()).toBe(false);
    stop();
    agent.dispose();
  });

  it("resumes from the cursor and folds only the new events onto the kept thread", async () => {
    const { agent, urls, stop } = await pump(
      [
        [...turn(1, "a", "one"), synced(5)],
        [{ kind: "resume" }, ...turn(6, "b", "two"), synced(10)],
      ],
      2,
    );
    const generation = agent.foldGeneration();

    expect(urls[0]).not.toContain("afterSeq");
    expect(urls[1]).toContain(`afterSeq=5&checksum=${sum(5)}`);
    expect(texts(agent)).toEqual(["one", "two"]);
    expect(agent.streamCursor()).toEqual({ seq: 10, checksum: sum(10) });
    expect(agent.foldGeneration()).toBe(generation);
    stop();
    agent.dispose();
  });

  it("re-folds from empty on `reset`", async () => {
    const { agent, stop } = await pump(
      [
        [...turn(1, "a", "stale"), synced(5)],
        [{ kind: "reset" }, ...turn(1, "x", "fresh"), synced(5)],
      ],
      2,
    );
    expect(texts(agent)).toEqual(["fresh"]);
    stop();
    agent.dispose();
  });

  it("re-folds from empty when the server ignores the cursor", async () => {
    const { agent, stop } = await pump(
      [
        [...turn(1, "a", "one"), synced(5)],
        [...turn(1, "a", "one"), ...turn(6, "b", "two"), synced(10)],
      ],
      2,
    );
    expect(texts(agent)).toEqual(["one", "two"]);
    stop();
    agent.dispose();
  });

  it("skips a frame that does not chain and resumes from the last good cursor", async () => {
    // seq 6 is missing, so seq 7 does not chain onto the cursor at 5.
    const [, ...afterGap] = turn(6, "b", "two");
    const { agent, urls, stop } = await pump(
      [
        [...turn(1, "a", "one"), synced(5)],
        [{ kind: "resume" }, ...afterGap.map((f) => ({ ...f, prevChecksum: sum(99) }))],
        [{ kind: "resume" }, ...turn(6, "b", "two"), synced(10)],
      ],
      3,
    );
    expect(urls[2]).toContain(`afterSeq=5&checksum=${sum(5)}`);
    expect(texts(agent)).toEqual(["one", "two"]);
    expect(agent.streamCursor()).toEqual({ seq: 10, checksum: sum(10) });
    stop();
    agent.dispose();
  });

  it("skips a redelivered frame without reconnecting", async () => {
    const b = turn(6, "b", "two");
    const { agent, urls, stop } = await pump(
      [
        [...turn(1, "a", "one"), synced(5)],
        [{ kind: "resume" }, ...b, b[4], b[4], synced(10)],
      ],
      2,
    );
    expect(urls).toHaveLength(2);
    expect(texts(agent)).toEqual(["one", "two"]);
    expect(agent.streamCursor()).toEqual({ seq: 10, checksum: sum(10) });
    stop();
    agent.dispose();
  });
});

describe("IntegrityAgent restored from the cache", () => {
  /** A settled snapshot, JSON round-tripped like the cache. */
  async function cachedSnapshot() {
    const { agent, stop } = await pump([[...turn(1, "a", "one"), synced(5)]], 1);
    const snap = JSON.parse(JSON.stringify(agent.snapshotFold()));
    stop();
    agent.dispose();
    return snap;
  }

  it("snapshots nothing mid-replay or without a cursor", () => {
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: vi.fn() as never });
    expect(agent.snapshotFold()).toBeUndefined();
    agent.dispose();
  });

  it("paints the cached thread at once and resumes its first connection from the cursor", async () => {
    const snap = await cachedSnapshot();
    const { fetchImpl, urls } = scriptedFetch([[{ kind: "resume" }, ...turn(6, "b", "two"), synced(10)]]);
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl, idleReconnectMs: 0 });

    agent.restoreFold(snap);
    expect(texts(agent)).toEqual(["one"]);
    expect(agent.isSyncingFromCache()).toBe(true);

    const stop = agent.renderPump();
    await vi.waitFor(() => expect(agent.isSyncingFromCache()).toBe(false));

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`afterSeq=5&checksum=${sum(5)}`);
    expect((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls.some(([u]) => u.includes("/tail"))).toBe(false);
    expect(texts(agent)).toEqual(["one", "two"]);
    stop();
    agent.dispose();
  });

  it("keeps the cached thread on screen through a reset, then shows the fresh replay", async () => {
    const snap = await cachedSnapshot();
    const { fetchImpl } = scriptedFetch([[{ kind: "reset" }, ...turn(1, "x", "fresh"), synced(5)]]);
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl, idleReconnectMs: 0 });
    const painted: number[] = [];
    agent.subscribe({ onMessagesChanged: () => void painted.push(agent.messages.length) });

    agent.restoreFold(snap);
    const stop = agent.renderPump();
    await vi.waitFor(() => expect(agent.isSyncingFromCache()).toBe(false));

    expect(texts(agent)).toEqual(["fresh"]);
    expect(painted, "never blanked between cache and replay").not.toContain(0);
    stop();
    agent.dispose();
  });
});
