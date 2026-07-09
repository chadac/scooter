/**
 * Tier 1 (ui) — IntegrityAgent full-fidelity rendering + fire-and-forget send.
 *
 * Proves the core guarantee: an IntegrityAgent driven by a scripted integrity
 * stream (text + a tool call + a reasoning block, each in a checksum envelope)
 * folds — via the AbstractAgent base applier — into the SAME full-fidelity
 * message state assistant-ui renders from a locally-driven /agui run. And a send
 * is fire-and-forget: POST /agui without consuming its SSE.
 */

import { describe, it, expect, vi } from "vitest";
import { firstValueFrom, take, toArray } from "rxjs";

import { createIntegrityAgent } from "./integrityAgent.js";
import type { RunAgentInput } from "@ag-ui/client";

// A scripted integrity stream: TEXT + TOOL_CALL_* + REASONING_*, checksum-wrapped
// (shapes mirror bridge.ts AguiEvent + integrityStream.ts IntegrityFrame). The
// inner events ARE @ag-ui/core BaseEvents, so IntegrityAgent.run() emits them as-is.
const FRAMES = [
  { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
  { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
  { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Working on it" } },
  { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
  { kind: "event", event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "run_command" } },
  { kind: "event", event: { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"cmd":"ls"}' } },
  { kind: "event", event: { type: "TOOL_CALL_END", toolCallId: "t1" } },
  { kind: "event", event: { type: "REASONING_START", messageId: "g1" } },
  { kind: "event", event: { type: "REASONING_MESSAGE_START", messageId: "g1", role: "reasoning" } },
  { kind: "event", event: { type: "REASONING_MESSAGE_CONTENT", messageId: "g1", delta: "think" } },
  { kind: "event", event: { type: "REASONING_MESSAGE_END", messageId: "g1" } },
  { kind: "event", event: { type: "REASONING_END", messageId: "g1" } },
  { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
  { kind: "synced" },
];

/** A fetch stub: the SSE ReadableStream for the integrity stream, and an empty
 *  JSON tail for the /tail fast-first-paint fetch (so seedTail no-ops in tests
 *  that only script the stream). Pass `tailEvents` to exercise the tail seed. */
function sseFetch(frames: unknown[], tailEvents: unknown[] = []): typeof fetch {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/tail")) {
      return new Response(JSON.stringify({ events: tailEvents }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

const EMPTY_INPUT = { threadId: "c1", runId: "r1", messages: [], tools: [], context: [], state: {}, forwardedProps: {} } as unknown as RunAgentInput;

describe("IntegrityAgent", () => {
  it("run() emits the integrity log's events as BaseEvents (text + tool call + reasoning)", async () => {
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(FRAMES) });
    // run() is a CONTINUOUS stream (reconnects when a stream ends) — it never
    // completes, so take exactly the scripted event count (synced carries no
    // event and is skipped).
    const expected = FRAMES.filter((f) => f.kind === "event");
    const events = await firstValueFrom(agent.run(EMPTY_INPUT).pipe(take(expected.length), toArray()));
    const types = events.map((e) => (e as { type: string }).type);
    // `synced` is skipped (no event); every "event" frame is forwarded.
    expect(types).toEqual(expected.map((f) => (f.event as { type: string }).type));
    // Full fidelity: text, tool call, AND reasoning are all present.
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    expect(types).toContain("TOOL_CALL_START");
    expect(types).toContain("REASONING_MESSAGE_CONTENT");
    agent.dispose();
  });

  it("REPLAY through the base applier keeps the tool call in fromAgUiMessages (refresh path)", async () => {
    // Mirrors RuntimeProvider's render pump: drive the base AbstractAgent applier
    // over the integrity stream (via agent.renderPump), then convert agent.messages
    // the way the pump does. This is the page-refresh replay path where tool calls
    // went missing — assert they SURVIVE into the assistant-ui thread messages.
    const { fromAgUiMessages } = await import("@assistant-ui/react-ag-ui");
    const fetchSpy = vi.fn(sseFetch(FRAMES)) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });

    // Drive the render pump exactly as RuntimeProvider does. The pump folds each
    // SSE connection fresh (one connection == one fold == one fetch of the log),
    // then reconnects after a delay. Stop the pump once the FIRST fold has gone
    // quiet (a short debounce after the last message change) so we assert on a
    // single fold's result — exactly one fetch drove it.
    const stop = agent.renderPump();
    const settled = new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => { unsubscribe(); stop(); resolve(); };
      const { unsubscribe } = agent.subscribe({
        onMessagesChanged: () => {
          clearTimeout(timer);
          timer = setTimeout(done, 200); // quiet for 200ms => fold settled
        },
      });
      setTimeout(done, 1500); // hard cap
    });
    await settled;

    // agent.messages should carry the tool call (applier attaches it to a msg).
    const agMsgs = (agent as unknown as { messages: Array<{ id: string; role: string; toolCalls?: Array<{ function: { arguments: string } }> }> }).messages;
    const withTool = agMsgs.filter((m) => (m.toolCalls?.length ?? 0) > 0);
    expect(withTool.length, "applier should attach the tool call to a message").toBeGreaterThan(0);

    // NO DOUBLE-APPLICATION: the pump folds each connection fresh (setMessages([])
    // per connection) so the log's full-log replay rebuilds identical state rather
    // than doubling. Without that the args come out doubled ('{"cmd":"ls"}{"cmd":"ls"}')
    // and messages duplicate. Also assert exactly ONE fetch drove this replay.
    expect(withTool[0].toolCalls![0].function.arguments).toBe('{"cmd":"ls"}');
    // Exactly one assistant-with-toolcall and one tool-result message (not two each).
    expect(agMsgs.filter((m) => m.id === "t1" && m.role === "assistant").length).toBe(1);
    // Exactly ONE integrity-stream fetch drove this replay (the /tail seed is a
    // separate fetch and doesn't re-fold the stream).
    const streamFetches = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes("events.integrity"));
    expect(streamFetches.length, "one stream fetch per fold").toBe(1);

    // And it must survive the conversion the pump feeds the thread.
    const threadMsgs = fromAgUiMessages(agent.messages as never);
    expect(JSON.stringify(threadMsgs), "fromAgUiMessages must keep the tool call").toContain("run_command");
    agent.dispose();
  });

  it("send() issues a fire-and-forget POST /agui and does NOT consume its SSE", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      // Return a never-ending body; if send() consumed it, the await would hang.
      return new Response(new ReadableStream(), { status: 200 });
    }) as unknown as typeof fetch;
    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", model: "opus", fetchImpl: fetchSpy,
    });

    await agent.send("hello world");

    const call = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://host/agui");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["X-Agent-Model"]).toBe("opus");
    const sent = JSON.parse(call[1].body);
    expect(sent.threadId).toBe("c1");
    expect(sent.messages[0]).toMatchObject({ role: "user", content: "hello world" });
    expect(sent.priority).toBeUndefined(); // a plain send carries no priority
    agent.dispose();
  });

  it("send({priority}) tags the POST with priority (to force-interrupt a running turn)", async () => {
    const fetchSpy = vi.fn(async () => new Response(new ReadableStream(), { status: 200 })) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });

    await agent.send("cancel that", { priority: 10 });

    const call = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = JSON.parse(call[1].body);
    expect(sent.priority).toBe(10); // preempts the running turn (uninterruptible-loop fix)
    agent.dispose();
  });

  it("submitResume() POSTs /agui with resume[] to answer an interrupt", async () => {
    const fetchSpy = vi.fn(async () => new Response(new ReadableStream(), { status: 200 })) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });

    await agent.submitResume([{ interruptId: "i1", status: "resolved", payload: { optionId: "yes" } }]);

    const call = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = JSON.parse(call[1].body);
    expect(sent.resume[0]).toMatchObject({ interruptId: "i1", status: "resolved" });
    agent.dispose();
  });

  // --- external (broker AWS) interrupts survive concurrent runs + reload -------
  async function foldTo(agent: ReturnType<typeof createIntegrityAgent>) {
    const stop = agent.renderPump();
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => { unsub(); stop(); resolve(); };
      const { unsubscribe: unsub } = agent.subscribe({
        onMessagesChanged: () => { clearTimeout(timer); timer = setTimeout(done, 150); },
      });
      setTimeout(done, 1200);
    });
  }

  it("SEEDS the recent tail (fast first paint) before the full replay", async () => {
    // The /tail fetch returns a couple of runs; the pump folds them + paints them
    // immediately, then the (empty, in this test) stream re-folds. We assert the
    // tail messages showed up — i.e. first paint didn't wait for the stream.
    const tail = [
      { type: "TEXT_MESSAGE_START", messageId: "tm1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "tm1", delta: "recent context" },
      { type: "TEXT_MESSAGE_END", messageId: "tm1" },
    ];
    // Stream serves only a synced marker (no events) so it can't be the source of
    // the message — only the tail seed can.
    const fetchSpy = vi.fn(sseFetch([{ kind: "synced" }], tail)) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });

    let sawTail = false;
    const stop = agent.renderPump();
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => { unsub(); stop(); resolve(); };
      const { unsubscribe: unsub } = agent.subscribe({
        onMessagesChanged: () => {
          if (JSON.stringify(agent.messages).includes("recent context")) sawTail = true;
          clearTimeout(timer); timer = setTimeout(done, 150);
        },
      });
      setTimeout(done, 1200);
    });
    expect(sawTail).toBe(true); // the tail painted (a /tail fetch happened)
    expect((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes("/tail"))).toBe(true);
    agent.dispose();
  });

  it("does NOT blank the thread when the tail folds to nothing (in-flight final run)", async () => {
    // The reported bug: /tail returns events, but they fold to NO renderable
    // message (the tail's last run is still in-flight — RUN_STARTED + partial, no
    // RUN_FINISHED). The seed must not blank the thread; the full replay (which
    // has the complete history) must still populate it.
    const inflightTail = [
      { type: "RUN_STARTED", threadId: "c1", runId: "live" },
      { type: "TEXT_MESSAGE_START", messageId: "p1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "p1", delta: "typing…" },
      // no TEXT_MESSAGE_END, no RUN_FINISHED — an in-flight run
    ];
    // The full stream DOES have a complete message.
    const stream = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "full history here" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(stream, inflightTail) });
    await foldTo(agent);
    // NOT blank — the full replay populated it despite the empty tail fold.
    expect(JSON.stringify(agent.messages)).toContain("full history here");
    agent.dispose();
  });

  it("SUPPRESSES per-event renders during replay, then renders once at `synced`", async () => {
    // A long conversation must not visibly build top-down on switch: while
    // replaying (before the `synced` marker) isReplaying() is true and the pump
    // suppresses renders; at `synced` it flips false and fires once with the whole
    // history. Model on RuntimeProvider.push (which reads isReplaying()).
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(FRAMES) });
    let replayingWhenNotified: boolean[] = [];
    let effectiveRenders = 0; // renders the pump would actually apply (isReplaying()===false)
    const stop = agent.renderPump();
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => { unsub(); stop(); resolve(); };
      const { unsubscribe: unsub } = agent.subscribe({
        onMessagesChanged: () => {
          replayingWhenNotified.push(agent.isReplaying());
          if (!agent.isReplaying()) effectiveRenders += 1;
          clearTimeout(timer); timer = setTimeout(done, 150);
        },
      });
      setTimeout(done, 1200);
    });
    // FRAMES has 13 events; without suppression the pump would apply ~13 renders.
    // With it, the effective (non-replaying) renders collapse to ~1 (the synced one).
    expect(effectiveRenders).toBeLessThanOrEqual(2);
    expect(effectiveRenders).toBeGreaterThan(0); // the history DID render (once)
    expect(agent.isReplaying()).toBe(false);     // replay finished
    agent.dispose();
  });

  it("an external (ext-) interrupt SURVIVES a concurrent goose run's RUN_STARTED/RUN_FINISHED", async () => {
    // The AWS-request bug: raiseInterrupt emits RUN_FINISHED(runId ext-aws1); the
    // still-live goose run then emits its own RUN_STARTED/RUN_FINISHED (no
    // interrupt), which used to CLEAR the pending interrupt → gone on reload.
    const frames = [
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-aws1",
        outcome: { type: "interrupt", interrupts: [{ id: "aws1", reason: "confirmation", message: "approve AWS?" }] } } },
      // The concurrent goose run continues and finishes normally:
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "g9" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m9", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m9", delta: "still working" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m9" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "g9" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    const pending = agent.getPendingInterrupts();
    expect(pending.map((p) => p.id)).toContain("aws1"); // NOT cleared by the goose run
    agent.dispose();
  });

  it("a PERMISSION_RESOLVED settles the external interrupt (so a resolved one stays gone on reload)", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-aws1",
        outcome: { type: "interrupt", interrupts: [{ id: "aws1", reason: "confirmation", message: "approve AWS?" }] } } },
      { kind: "event", event: { type: "PERMISSION_RESOLVED", toolCallId: "aws1", optionId: "approve" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getPendingInterrupts().map((p) => p.id)).not.toContain("aws1");
    agent.dispose();
  });

  // --- run-in-flight (Stop button + thinking indicator) ------------------------

  it("runIsActive() is true after RUN_STARTED and false after RUN_FINISHED", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hi" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    // The stream ran a full turn to completion -> not running.
    expect(agent.runIsActive()).toBe(false);
    agent.dispose();
  });

  it("runIsActive() STAYS running when a run has started but not finished", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      { kind: "synced" }, // stream synced mid-run (still working)
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.runIsActive()).toBe(true);
    agent.dispose();
  });

  it("runIsActive() IGNORES out-of-band ext- runs (a broker interrupt isn't 'thinking')", async () => {
    const frames = [
      // An external interrupt run — must NOT flip runIsActive on.
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "ext-aws1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-aws1",
        outcome: { type: "interrupt", interrupts: [{ id: "aws1", reason: "confirmation" }] } } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.runIsActive()).toBe(false);
    agent.dispose();
  });

  it("runIsActive() flips false on RUN_ERROR too", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "RUN_ERROR", threadId: "c1", runId: "r1", message: "boom" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.runIsActive()).toBe(false);
    agent.dispose();
  });

  it("getRunError() surfaces the RUN_ERROR message (the base applier renders none)", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "RUN_ERROR", threadId: "c1", runId: "r1", message: "The agent could not start this run: 409" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getRunError()).toBe("The agent could not start this run: 409");
    agent.dispose();
  });

  it("getRunError() is null when the last run succeeded", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getRunError()).toBeNull();
    agent.dispose();
  });

  it("getRunError() CLEARS when a subsequent run starts (stale error doesn't linger)", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "RUN_ERROR", threadId: "c1", runId: "r1", message: "boom" } },
      // The user retries — a new run begins; the old error must not stick.
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r2" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getRunError()).toBeNull();
    expect(agent.runIsActive()).toBe(true);
    agent.dispose();
  });

  it("getRunError() IGNORES an out-of-band ext- run error (a broker run isn't a turn failure)", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_ERROR", threadId: "c1", runId: "ext-aws1", message: "broker hiccup" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getRunError()).toBeNull();
    agent.dispose();
  });

  it("getQueuedMessages() re-derives the queue from the last QUEUE_UPDATED snapshot", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "QUEUE_UPDATED", items: [{ id: "q1", text: "queued A", priority: 0 }] } },
      { kind: "event", event: { type: "QUEUE_UPDATED", items: [
        { id: "q1", text: "queued A", priority: 0 },
        { id: "q2", text: "queued B", priority: 0 },
      ] } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    // Latest snapshot wins — both queued messages, in order.
    expect(agent.getQueuedMessages().map((m) => m.text)).toEqual(["queued A", "queued B"]);
    agent.dispose();
  });

  it("getQueuedMessages() clears when the queue drains (empty snapshot)", async () => {
    const frames = [
      { kind: "event", event: { type: "QUEUE_UPDATED", items: [{ id: "q1", text: "queued A", priority: 0 }] } },
      // The run pulled it out to run — queue is now empty.
      { kind: "event", event: { type: "QUEUE_UPDATED", items: [] } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getQueuedMessages()).toEqual([]);
    agent.dispose();
  });

  it("cancel() POSTs the agent-host cancel endpoint for the conversation", async () => {
    const fetchSpy = vi.fn(async () => new Response("", { status: 202 })) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });

    await agent.cancel();

    const call = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://host/conversations/c1/cancel");
    expect(call[1].method).toBe("POST");
    agent.dispose();
  });

  it("cancel() THROWS on a non-2xx response (so the UI can show the stop didn't land)", async () => {
    const fetchSpy = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });
    await expect(agent.cancel()).rejects.toThrow(/cancel request failed: 500/);
    agent.dispose();
  });

  it("cancel() THROWS on a network error (fetch rejects) rather than swallowing it", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });
    await expect(agent.cancel()).rejects.toThrow(/network down/);
    agent.dispose();
  });
});
