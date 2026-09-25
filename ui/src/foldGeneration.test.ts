/**
 * FOLD GENERATION — the signal that tells a re-fold apart from a shrink.
 *
 * Each connection re-folds the log from an empty accumulator over the server's trailing
 * window, so the list it produces can be SHORTER than the one before it. The render pump
 * suppresses shrinking lists (a shorter list mid-render crashes assistant-ui's lookup),
 * so it needs to know when a shrink is a new fold rather than a mid-fold frame —
 * otherwise its high-water mark latches and the transcript freezes until a refresh.
 *
 * This asserts the generation moves exactly when a fold restarts: per CONNECTION, and
 * not for a prepend of paged-in history (same fold, list legitimately grows).
 */

import { describe, it, expect, vi } from "vitest";

import { createIntegrityAgent } from "./integrityAgent.js";

const msg = (id: string) => ({ id, role: "assistant", content: id });

/** A finished turn, then the stream goes byte-silent without closing — the drop the
 *  idle watchdog exists to heal. Every connection serves the same body. */
function silentAfterSyncFetch(onConnect: () => void): typeof fetch {
  const frames = [
    { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
    { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
    { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "done" } },
    { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
    { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
    { kind: "synced" },
  ];
  return vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/tail")) {
      return new Response(JSON.stringify({ events: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    onConnect();
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        // Deliberately never closed: a silent stream, not a clean end.
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

describe("fold generation", () => {
  it("advances on every reconnect (each connection is a new fold)", async () => {
    let conns = 0;
    const agent = createIntegrityAgent({
      baseUrl: "http://host",
      conversationId: "c1",
      fetchImpl: silentAfterSyncFetch(() => { conns++; }),
      idleReconnectMs: 80,
    });
    const stop = agent.renderPump();
    try {
      await new Promise((r) => setTimeout(r, 60));
      const first = agent.foldGeneration();
      // Let the watchdog notice the silence and force a reconnect.
      await new Promise((r) => setTimeout(r, 400));
      expect(conns, "the watchdog must have reconnected").toBeGreaterThanOrEqual(2);
      expect(
        agent.foldGeneration(),
        "a reconnect re-folds from empty — the consumer's high-water mark must reset",
      ).toBeGreaterThan(first);
    } finally {
      stop();
      agent.dispose();
    }
  });

  it("does NOT advance when older history is prepended (same fold)", async () => {
    const impl = vi.fn(async (url: string) => {
      if (String(url).includes("/messages?before=")) {
        return new Response(
          JSON.stringify({ messages: [msg("old1"), msg("old2")], fromSeq: 1, done: true }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: impl });
    // Seed a windowed snapshot the way the stream loop does.
    const a = agent as unknown as {
      trackHistoryCursor: (e: unknown) => boolean;
      setMessages: (m: unknown[]) => void;
    };
    a.setMessages([msg("new1")]);
    a.trackHistoryCursor({ type: "MESSAGES_SNAPSHOT", messages: [msg("new1")], fromSeq: 500 });

    const before = agent.foldGeneration();
    expect(await agent.loadOlderHistory()).toBe(2);
    expect(agent.foldGeneration(), "a prepend grows the SAME fold").toBe(before);
    agent.dispose();
  });
});
