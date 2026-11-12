/**
 * Scroll-back paging of older history.
 *
 * The initial MESSAGES_SNAPSHOT paints only the trailing window and carries `fromSeq`,
 * where that window starts; the agent pages older messages in from there, prepending them.
 */
import { describe, it, expect, vi } from "vitest";

import { createIntegrityAgent } from "./integrityAgent.js";

const msg = (id: string) => ({ id, role: "assistant", content: id });

type Page = { messages: unknown[]; fromSeq: number; done: boolean };

/** Serve `pages` to the older-history endpoint, in order. */
function pagingFetch(pages: Page[]) {
  let n = 0;
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("/messages?before=")) {
      const body = pages[n] ?? { messages: [], fromSeq: 1, done: true };
      n++;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Apply a MESSAGES_SNAPSHOT the way the stream loop does: seed the visible messages, then let the cursor tracker read `fromSeq`. */
function applySnapshot(
  agent: ReturnType<typeof createIntegrityAgent>,
  messages: unknown[],
  fromSeq?: number,
) {
  const a = agent as unknown as {
    trackHistoryCursor: (e: unknown) => boolean;
    setMessages: (m: unknown[]) => void;
  };
  a.setMessages(messages);
  a.trackHistoryCursor({ type: "MESSAGES_SNAPSHOT", messages, ...(fromSeq ? { fromSeq } : {}) });
}

const ids = (agent: ReturnType<typeof createIntegrityAgent>) =>
  (agent.visibleMessages() as Array<{ id: string }>).map((m) => m.id);

function makeAgent(pages: Page[]) {
  const { impl, calls } = pagingFetch(pages);
  const agent = createIntegrityAgent({
    conversationId: "c1",
    baseUrl: "http://host",
    fetchImpl: impl,
  });
  return { agent, calls };
}

describe("older-history paging", () => {
  it("reports no older history when the snapshot is the whole log", async () => {
    const { agent } = makeAgent([]);
    applySnapshot(agent, [msg("new1")]); // no fromSeq → nothing older
    expect(agent.hasOlderHistory()).toBe(false);
    expect(await agent.loadOlderHistory()).toBe(0);
  });

  it("reports older history when the snapshot is windowed", () => {
    const { agent } = makeAgent([]);
    applySnapshot(agent, [msg("new1")], 500);
    expect(agent.hasOlderHistory()).toBe(true);
  });

  it("prepends an older page before the messages already shown", async () => {
    const { agent } = makeAgent([{ messages: [msg("old1"), msg("old2")], fromSeq: 300, done: false }]);
    applySnapshot(agent, [msg("new1"), msg("new2")], 500);
    expect(await agent.loadOlderHistory()).toBe(2);
    expect(ids(agent)).toEqual(["old1", "old2", "new1", "new2"]);
  });

  it("asks for the page before the current window, then before that one", async () => {
    const { agent, calls } = makeAgent([
      { messages: [msg("b1")], fromSeq: 300, done: false },
      { messages: [msg("a1")], fromSeq: 1, done: true },
    ]);
    applySnapshot(agent, [msg("new1")], 500);
    await agent.loadOlderHistory();
    await agent.loadOlderHistory();
    const asked = calls.filter((u) => u.includes("/messages?before="));
    expect(asked[0]).toContain("before=500");
    expect(asked[1], "the cursor must advance to the page just loaded").toContain("before=300");
  });

  it("walks back page by page and stops at the start of the log", async () => {
    const { agent, calls } = makeAgent([
      { messages: [msg("b1")], fromSeq: 300, done: false },
      { messages: [msg("a1")], fromSeq: 1, done: true },
    ]);
    applySnapshot(agent, [msg("new1")], 500);
    await agent.loadOlderHistory();
    expect(agent.hasOlderHistory()).toBe(true);
    await agent.loadOlderHistory();
    expect(agent.hasOlderHistory(), "done must end the walk").toBe(false);
    expect(ids(agent)).toEqual(["a1", "b1", "new1"]);
    // Exhausted: no further request is made.
    expect(await agent.loadOlderHistory()).toBe(0);
    expect(calls.filter((u) => u.includes("/messages?before=")).length).toBe(2);
  });

  it("collapses concurrent loads onto one request", async () => {
    // A scroll handler fires continuously, so each event must not stack a duplicate fetch.
    const { agent, calls } = makeAgent([{ messages: [msg("old1")], fromSeq: 300, done: false }]);
    applySnapshot(agent, [msg("new1")], 500);
    const [a, b, c] = await Promise.all([
      agent.loadOlderHistory(),
      agent.loadOlderHistory(),
      agent.loadOlderHistory(),
    ]);
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(calls.filter((u) => u.includes("/messages?before=")).length).toBe(1);
    expect(ids(agent)).toEqual(["old1", "new1"]);
  });

  it("survives a failed page fetch and can retry", async () => {
    let first = true;
    const impl = vi.fn(async (url: string) => {
      if (url.includes("/messages?before=")) {
        if (first) {
          first = false;
          return new Response("nope", { status: 500 });
        }
        return new Response(
          JSON.stringify({ messages: [msg("old1")], fromSeq: 1, done: true }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ conversationId: "c1", baseUrl: "http://host", fetchImpl: impl });
    applySnapshot(agent, [msg("new1")], 500);
    expect(await agent.loadOlderHistory()).toBe(0);
    expect(agent.hasOlderHistory(), "a failed page must not end the walk").toBe(true);
    expect(await agent.loadOlderHistory()).toBe(1);
    expect(ids(agent)).toEqual(["old1", "new1"]);
  });
});

const frame = (f: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`);

// The applier rewrites `messages` per event, so paged-in history must live elsewhere.
describe("older history during a live stream", () => {
  it("keeps prepended pages after the next live event", async () => {
    let push: ((f: unknown) => void) | undefined;
    const impl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/tail")) return new Response(JSON.stringify({ events: [] }), { status: 200 });
      if (u.includes("/messages?before=")) {
        return new Response(
          JSON.stringify({ messages: [msg("old1"), msg("old2")], fromSeq: 1, done: true }),
          { status: 200 },
        );
      }
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          push = (f) => c.enqueue(frame(f));
          push({ kind: "event", event: { type: "MESSAGES_SNAPSHOT", messages: [msg("new1")], fromSeq: 500 } });
          push({ kind: "synced" });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: impl });
    const stop = agent.renderPump();
    try {
      await vi.waitFor(() => expect(agent.visibleMessages()).toHaveLength(1));
      expect(await agent.loadOlderHistory()).toBe(2);
      expect(agent.visibleMessages().map((m) => (m as { id: string }).id)).toEqual(["old1", "old2", "new1"]);

      push?.({ kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "new2", role: "assistant" } });
      push?.({ kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "new2", delta: "hi" } });
      push?.({ kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "new2" } });

      await vi.waitFor(() =>
        expect(agent.visibleMessages().map((m) => (m as { id: string }).id)).toEqual([
          "old1",
          "old2",
          "new1",
          "new2",
        ]),
      );
    } finally {
      stop();
      agent.dispose();
    }
  });
});
