/**
 * The conversation-list stream's frame contract and its recovery paths. The stream is the
 * sidebar's only source of the list, so a dropped or misread frame leaves it disagreeing with
 * the server until something reconnects — every frame kind, every malformed one, and the
 * stale-socket watchdog that turns silence into a reconnect are pinned here.
 */
import { describe, it, expect, vi } from "vitest";

import { subscribeConversations } from "./conversationStream.js";
import type { ConversationView } from "./client.js";

const conv = (id: string, title = "T"): ConversationView =>
  ({ id, title }) as unknown as ConversationView;

/** A fetch stub serving one scripted SSE body, then holding the stream open. */
function sseFetch(frames: unknown[]): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) {
          // Heartbeat comments and multi-line framing are part of the wire format.
          c.enqueue(enc.encode(typeof f === "string" ? f : `data: ${JSON.stringify(f)}\n\n`));
        }
        c.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

/** Run the subscription over a scripted body and collect what the callbacks saw. */
async function collect(frames: unknown[]) {
  const seen = { snapshots: [] as ConversationView[][], upserts: [] as ConversationView[], removes: [] as string[], contrib: [] as Array<[string, string[]]> };
  const sub = subscribeConversations(
    { baseUrl: "https://host" },
    "all",
    {
      onSnapshot: (l) => void seen.snapshots.push(l),
      onUpsert: (c) => void seen.upserts.push(c),
      onRemove: (id) => void seen.removes.push(id),
      onContrib: (name, ids) => void seen.contrib.push([name, ids]),
    },
    { fetchImpl: sseFetch(frames) },
  );
  // Let the reader drain the scripted body before asserting.
  await new Promise((r) => setTimeout(r, 0));
  sub.close();
  return seen;
}

describe("subscribeConversations frames", () => {
  it("applies a snapshot then upserts, in order", async () => {
    const seen = await collect([
      { kind: "snapshot", conversations: [conv("a"), conv("b")] },
      { kind: "upsert", conversation: conv("c") },
    ]);
    expect(seen.snapshots).toHaveLength(1);
    expect(seen.snapshots[0].map((c) => c.id)).toEqual(["a", "b"]);
    expect(seen.upserts.map((c) => c.id)).toEqual(["c"]);
  });

  it("applies a remove frame, which carries only an id", async () => {
    const seen = await collect([{ kind: "remove", id: "gone-1" }]);
    expect(seen.removes).toEqual(["gone-1"]);
    expect(seen.upserts).toEqual([]);
  });

  it("ignores a remove naming no conversation rather than removing something arbitrary", async () => {
    const seen = await collect([{ kind: "remove" }, { kind: "remove", id: "" }]);
    expect(seen.removes).toEqual([]);
  });

  it("passes a contrib's change on, an absent id list meaning any", async () => {
    const seen = await collect([
      { kind: "contrib", contrib: "notes", conversations: ["c1"] },
      { kind: "contrib", contrib: "notes" },
      { kind: "contrib", conversations: ["c2"] },
    ]);
    expect(seen.contrib).toEqual([
      ["notes", ["c1"]],
      ["notes", []],
    ]);
  });

  it("ignores an unknown frame kind, so a newer server cannot break an older tab", async () => {
    const seen = await collect([{ kind: "reshuffle", whatever: 1 }, { kind: "remove", id: "x" }]);
    expect(seen.removes).toEqual(["x"]);
  });

  it("skips an unparseable frame and keeps reading the ones after it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen = await collect(["data: {not json\n\n", { kind: "remove", id: "after" }]);
    expect(seen.removes).toEqual(["after"]);
    warn.mockRestore();
  });

  it("ignores heartbeat comments", async () => {
    const seen = await collect([": keep-alive\n\n", { kind: "remove", id: "x" }]);
    expect(seen.removes).toEqual(["x"]);
  });

  it("handles a frame split across two chunks", async () => {
    // The body arrives in network-sized chunks, not frame-sized ones.
    const seen = await collect([`data: {"kind":"remove",`, `"id":"split"}\n\n`]);
    expect(seen.removes).toEqual(["split"]);
  });

  it("subscribes with the requested scope", async () => {
    const fetchImpl = vi.fn(sseFetch([]));
    const sub = subscribeConversations(
      { baseUrl: "https://host/" },
      "mine",
      { onSnapshot: () => {}, onUpsert: () => {}, onRemove: () => {} },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await new Promise((r) => setTimeout(r, 0));
    sub.close();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://host/conversations/events?scope=mine");
  });
});

describe("the stale-socket watchdog (silence is not health)", () => {
  /**
   * A fetch stub whose body never ends and never yields on its own, which is what a
   * black-holed TCP connection looks like from the client: readable forever, no error, no
   * bytes. Each call exposes its abort state and a push() so a test can feed bytes later.
   */
  function hangingFetch(perCall: Array<unknown[]>) {
    const enc = new TextEncoder();
    const calls: Array<{ aborted: () => boolean; push: (text: string) => void }> = [];
    const impl = (async (_url: string, init?: RequestInit) => {
      const frames = perCall[Math.min(calls.length, perCall.length - 1)] ?? [];
      const signal = init?.signal;
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          for (const f of frames) {
            c.enqueue(enc.encode(typeof f === "string" ? f : `data: ${JSON.stringify(f)}\n\n`));
          }
          // Deliberately never closed: as far as the client can tell, the connection is up.
        },
      });
      // Only an abort ends it, exactly as fetch does: the pending read rejects.
      signal?.addEventListener("abort", () => {
        try {
          ctrl.error(new Error("aborted"));
        } catch {
          /* already errored or closed */
        }
      });
      calls.push({
        aborted: () => signal?.aborted === true,
        push: (text: string) => ctrl.enqueue(enc.encode(text)),
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("reconnects — and so re-snapshots — when the server goes silent past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = hangingFetch([
        [{ kind: "snapshot", conversations: [conv("a")] }],
        [{ kind: "snapshot", conversations: [conv("a"), conv("b")] }],
      ]);
      const seen: ConversationView[][] = [];
      const sub = subscribeConversations(
        { baseUrl: "https://host" },
        "all",
        { onSnapshot: (l) => void seen.push(l), onUpsert: () => {}, onRemove: () => {} },
        { fetchImpl: impl, staleAfterMs: 1000 },
      );

      await vi.advanceTimersByTimeAsync(1);
      expect(seen, "the first snapshot arrives normally").toHaveLength(1);
      expect(calls).toHaveLength(1);

      // Silence past the deadline. The server's 25s heartbeat is not arriving and the read
      // will never return or throw, so the watchdog is the only thing that can notice.
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls[0].aborted(), "a silent stream must be aborted").toBe(true);

      // The reconnect re-snapshots, which is what repairs whatever the dead socket missed.
      await vi.advanceTimersByTimeAsync(600);
      expect(calls.length, "the client must reconnect after the abort").toBeGreaterThan(1);
      expect(seen).toHaveLength(2);
      expect(seen[1].map((c) => c.id)).toEqual(["a", "b"]);
      sub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a heartbeat comment counts as liveness, so an idle-but-healthy stream is left alone", async () => {
    vi.useFakeTimers();
    try {
      // On an idle deployment the server sends `: ping` every 25s and no data frames at all.
      // Counting only data frames as liveness would reconnect every tab, forever.
      const { impl, calls } = hangingFetch([[{ kind: "snapshot", conversations: [conv("a")] }]]);
      const sub = subscribeConversations(
        { baseUrl: "https://host" },
        "all",
        { onSnapshot: () => {}, onUpsert: () => {}, onRemove: () => {} },
        { fetchImpl: impl, staleAfterMs: 1000 },
      );
      await vi.advanceTimersByTimeAsync(1);

      // Three windows' worth of time, each with a heartbeat before the deadline.
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(800);
        calls[0].push(": ping\n\n");
        await vi.advanceTimersByTimeAsync(1);
        expect(calls[0].aborted(), "a heartbeat must reset the deadline").toBe(false);
      }
      expect(calls, "a healthy stream must not reconnect").toHaveLength(1);
      sub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("close() stops the watchdog, so a closed subscription never reconnects", async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = hangingFetch([[]]);
      const sub = subscribeConversations(
        { baseUrl: "https://host" },
        "all",
        { onSnapshot: () => {}, onUpsert: () => {}, onRemove: () => {} },
        { fetchImpl: impl, staleAfterMs: 1000 },
      );
      await vi.advanceTimersByTimeAsync(1);
      sub.close();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls, "a closed subscription must not re-open the stream").toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
