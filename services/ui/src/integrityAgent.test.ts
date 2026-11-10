/**
 * IntegrityAgent unit tests: a scripted integrity stream (text, tool call, reasoning)
 * folds through the AbstractAgent base applier into the same full-fidelity message state
 * assistant-ui renders from a local /agui run, a send is a fire-and-forget POST /agui, and
 * the render pump's reconnect, watchdog and interrupt tracking converge on the server log.
 */

import { describe, it, expect, vi } from "vitest";
import { firstValueFrom, take, toArray } from "rxjs";

import { createIntegrityAgent, describeSendError, SendError } from "./integrityAgent.js";
import { stateFeed, type TopicEvent } from "./stateFeed.js";
import type { RunAgentInput } from "@ag-ui/client";

// A scripted integrity stream whose inner events are @ag-ui/core BaseEvents.
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

/** A fetch stub serving the scripted SSE stream and a JSON /tail body (empty unless `tailEvents` is given). */
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

/** A snapshot of the whole UI-visible surface an IntegrityAgent drives, so a recovery test can assert every field healed. */
function uiState(agent: ReturnType<typeof createIntegrityAgent>) {
  const messages = (agent as unknown as { messages: Array<{ role?: string; content?: unknown }> }).messages ?? [];
  const feed = messages.map((m) => {
    const c = m.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "").join("") : "";
    return { role: m.role, text };
  });
  return {
    feed,
    feedText: feed.map((m) => m.text).join(" | "),
    running: agent.runIsActive(),
    activeTool: agent.activeTool(),
    queue: agent.getQueuedMessages().map((q) => q.text),
    interrupts: agent.getPendingInterrupts().map((i) => i.id),
    runError: agent.getRunError(),
    authError: agent.getStreamAuthError(),
  };
}

describe("IntegrityAgent", () => {
  it("run() emits the integrity log's events as BaseEvents (text + tool call + reasoning)", async () => {
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(FRAMES) });
    // run() never completes, so take exactly the scripted event count.
    const expected = FRAMES.filter((f) => f.kind === "event");
    const events = await firstValueFrom(agent.run(EMPTY_INPUT).pipe(take(expected.length), toArray()));
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(expected.map((f) => (f.event as { type: string }).type));
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    expect(types).toContain("TOOL_CALL_START");
    expect(types).toContain("REASONING_MESSAGE_CONTENT");
    agent.dispose();
  });

  it("hands state topics on the stream to the state feed, and reports the stream ending", async () => {
    const heard: TopicEvent[] = [];
    const stopReading = stateFeed.subscribe("c1", "sandbox", (e) => void heard.push(e));
    const frames = [
      { kind: "synced" },
      { kind: "topic", topic: "sandbox", data: { ready: true } },
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await firstValueFrom(agent.run(EMPTY_INPUT).pipe(take(1)));
    await vi.waitFor(() => expect(heard.at(-1)).toEqual({ kind: "down" }));
    expect(heard.slice(0, 2)).toEqual([{ kind: "open" }, { kind: "data", data: { ready: true } }]);
    agent.dispose();
    stopReading();
  });

  it("REPLAY through the base applier keeps the tool call in fromAgUiMessages (refresh path)", async () => {
    // Drive the render pump as RuntimeProvider does, then convert agent.messages the way the pump does.
    const { fromAgUiMessages } = await import("@assistant-ui/react-ag-ui");
    const fetchSpy = vi.fn(sseFetch(FRAMES)) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });

    // Stop the pump once the first fold has gone quiet so the assertions cover a single fold.
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

    const agMsgs = (agent as unknown as { messages: Array<{ id: string; role: string; toolCalls?: Array<{ function: { arguments: string } }> }> }).messages;
    const withTool = agMsgs.filter((m) => (m.toolCalls?.length ?? 0) > 0);
    expect(withTool.length, "applier should attach the tool call to a message").toBeGreaterThan(0);

    // The fold is not doubled by the replay.
    expect(withTool[0].toolCalls![0].function.arguments).toBe('{"cmd":"ls"}');
    expect(agMsgs.filter((m) => m.id === "t1" && m.role === "assistant").length).toBe(1);
    // The /tail seed is a separate fetch that does not re-fold the stream.
    const streamFetches = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes("events.integrity"));
    expect(streamFetches.length, "one stream fetch per fold").toBe(1);

    const threadMsgs = fromAgUiMessages(agent.messages as never);
    expect(JSON.stringify(threadMsgs), "fromAgUiMessages must keep the tool call").toContain("run_command");
    agent.dispose();
  });

  it("send() issues a fire-and-forget POST /agui and does NOT consume its SSE", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      // A never-ending body, so consuming it would hang the await.
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

  it("reports the model a send carried once the POST is accepted, and not on a failure", async () => {
    const sent: string[] = [];
    const ok = vi.fn(async () => new Response(new ReadableStream(), { status: 200 })) as unknown as typeof fetch;
    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", model: "opus", fetchImpl: ok, onModelSent: (m) => sent.push(m),
    });
    await agent.send("hi");
    expect(sent).toEqual(["opus"]);
    agent.dispose();

    const failed: string[] = [];
    const bad = vi.fn(async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const agent2 = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", model: "opus", fetchImpl: bad, onModelSent: (m) => failed.push(m),
    });
    await expect(agent2.send("hi")).rejects.toBeInstanceOf(SendError);
    expect(failed, "a refused send must keep the pick pending").toEqual([]);
    agent2.dispose();
  });

  it("send() REJECTS with a SendError carrying the status when POST /agui is refused (e.g. a 413 for an oversized image)", async () => {
    const cancel = vi.fn(async () => {});
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const tooLarge = vi.fn(async () => ({ ok: false, status: 413, body }) as unknown as Response) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: tooLarge });
    const err = await agent.send("look", { images: [{ data: "AAAA", mimeType: "image/png" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).status).toBe(413);
    expect(cancel, "a refused POST still releases its body").toHaveBeenCalledTimes(1);
    expect(describeSendError(err)).toMatch(/too large/);
    agent.dispose();
  });

  it("send() and submitResume() REJECT with a status-less SendError when the POST never reaches the server", async () => {
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: down });
    const sendErr = await agent.send("hi").catch((e: unknown) => e);
    expect(sendErr).toBeInstanceOf(SendError);
    expect((sendErr as SendError).status).toBeNull();
    expect(describeSendError(sendErr)).toMatch(/couldn't be reached/);
    await expect(agent.submitResume([{ interruptId: "i1", status: "resolved" }])).rejects.toBeInstanceOf(SendError);
    agent.dispose();
  });

  it("describeSendError names the status for other refusals", () => {
    expect(describeSendError(new SendError(502))).toBe("Your message wasn't sent (HTTP 502). Try again.");
    expect(describeSendError(new Error("no conversation selected"))).toBe("Your message wasn't sent: no conversation selected");
  });

  it("send() cancels the POST /agui response body (frees the HTTP/2 flow-control window)", async () => {
    // An unread POST /agui body would fill the HTTP/2 flow-control window and stall the integrity stream.
    const cancel = vi.fn(async () => {});
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const fetchSpy = vi.fn(
      async () => ({ ok: true, status: 200, body }) as unknown as Response,
    ) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });

    await agent.send("hello world");

    expect(cancel, "postAgui must cancel the unread SSE body").toHaveBeenCalledTimes(1);
    agent.dispose();
  });

  it("send({priority}) tags the POST with priority (to force-interrupt a running turn)", async () => {
    const fetchSpy = vi.fn(async () => new Response(new ReadableStream(), { status: 200 })) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });

    await agent.send("cancel that", { priority: 10 });

    const call = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = JSON.parse(call[1].body);
    expect(sent.priority).toBe(10); // preempts the running turn
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
    // The tail paints immediately, before the stream re-folds.
    const tail = [
      { type: "TEXT_MESSAGE_START", messageId: "tm1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "tm1", delta: "recent context" },
      { type: "TEXT_MESSAGE_END", messageId: "tm1" },
    ];
    // The stream serves no events, so only the tail seed can be the message's source.
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
    // A tail whose last run is still in flight folds to no renderable message, and must not blank the thread.
    const inflightTail = [
      { type: "RUN_STARTED", threadId: "c1", runId: "live" },
      { type: "TEXT_MESSAGE_START", messageId: "p1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "p1", delta: "typing…" },
      // no TEXT_MESSAGE_END, no RUN_FINISHED: an in-flight run
    ];
    // The full stream has a complete message.
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
    // The full replay populated it despite the empty tail fold.
    expect(JSON.stringify(agent.messages)).toContain("full history here");
    agent.dispose();
  });

  it("SUPPRESSES per-event renders during replay, then renders once at `synced`", async () => {
    // Renders are suppressed while isReplaying() and fire once at `synced`, as RuntimeProvider.push reads them.
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
    // Without suppression the pump would apply one render per event.
    expect(effectiveRenders).toBeLessThanOrEqual(2);
    expect(effectiveRenders).toBeGreaterThan(0); // the history DID render (once)
    expect(agent.isReplaying()).toBe(false);     // replay finished
    agent.dispose();
  });

  it("the PROGRESS/CONTEXT indicators do not replay their history on reconnect", async () => {
    // A pending-interrupt change notifies without the agent's own replay guard, so push() runs mid-replay.
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "CONTEXT_USAGE", usedTokens: 10_000, contextWindow: 200_000 } },
      { kind: "event", event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "early_tool" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1", outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "confirmation", message: "ok?" }] } } },
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r2" } },
      { kind: "event", event: { type: "TOOL_CALL_END", toolCallId: "t1" } },
      { kind: "event", event: { type: "CONTEXT_USAGE", usedTokens: 120_000, contextWindow: 200_000 } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r2" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    const samples: Array<{ fill: number | null }> = [];
    const stop = agent.renderPump();
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => { unsub(); stop(); resolve(); };
      const { unsubscribe: unsub } = agent.subscribe({
        onMessagesChanged: () => {
          clearTimeout(timer); timer = setTimeout(done, 150);
          // RuntimeProvider.push returns early while replaying.
          if (agent.isReplaying()) return;
          samples.push({ fill: agent.contextFill() });
        },
      });
      setTimeout(done, 1200);
    });
    // 0.05 is the intermediate reading, so only the settled tail may show.
    expect(samples.some((s) => s.fill !== null && Math.abs(s.fill - 0.05) < 1e-9)).toBe(false);
    expect(agent.contextFill()).toBeCloseTo(0.6, 5);
    agent.dispose();
  });

  it("a 401 surfaces the auth error EVEN WHILE REPLAYING (never behind the replay guard)", async () => {
    // A 401 never reaches `synced`, so a deferred banner would never show.
    const agent = createIntegrityAgent({
      baseUrl: "http://host",
      conversationId: "c1",
      fetchImpl: (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch,
    });
    const stop = agent.renderPump();
    await new Promise((r) => setTimeout(r, 400));
    expect(agent.isReplaying()).toBe(true);
    expect(agent.getStreamAuthError()).toBe(true);
    stop();
    agent.dispose();
  });

  it("an IN-FLIGHT run is still reported the moment replay ends (the silent-run case)", async () => {
    // The log ends with RUN_STARTED and no terminal, so runIsActive() must be true at `synced`.
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "slow_build" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    const stop = agent.renderPump();
    await new Promise((r) => setTimeout(r, 600));
    expect(agent.isReplaying()).toBe(false);
    expect(agent.runIsActive()).toBe(true);
    expect(agent.activeTool()).toBe("slow_build");
    stop();
    agent.dispose();
  });

  it("an external (ext-) interrupt SURVIVES a concurrent goose run's RUN_STARTED/RUN_FINISHED", async () => {
    // The concurrent goose run's RUN_STARTED/RUN_FINISHED must not clear the pending ext- interrupt.
    const frames = [
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-aws1",
        outcome: { type: "interrupt", interrupts: [{ id: "aws1", reason: "confirmation", message: "approve AWS?" }] } } },
      // The concurrent goose run continues and finishes normally.
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
    expect(pending.map((p) => p.id)).toContain("aws1");
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
    // A full turn ran to completion.
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

  // --- auto-retry banner (RUN_RETRYING → getRunRetrying) ------------------------
  it("getRunRetrying() reflects a RUN_RETRYING event (drives the 'retrying (n/N)…' banner)", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "RUN_ERROR", message: "agent died", code: "agent_process_died" } },
      { kind: "event", event: { type: "RUN_RETRYING", threadId: "c1", attempt: 2, max: 5, delayMs: 1000 } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getRunRetrying()).toEqual({ attempt: 2, max: 5 });
    agent.dispose();
  });

  it("a RUN_STARTED after RUN_RETRYING CLEARS the retrying state (the retry succeeded)", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_ERROR", message: "died", code: "agent_process_died" } },
      { kind: "event", event: { type: "RUN_RETRYING", threadId: "c1", attempt: 1, max: 5, delayMs: 500 } },
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r2" } }, // the retry began
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getRunRetrying()).toBeNull();
    agent.dispose();
  });

  it("a terminal RUN_ERROR after RUN_RETRYING clears retrying + surfaces the error (retries exhausted)", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_RETRYING", threadId: "c1", attempt: 5, max: 5, delayMs: 8000 } },
      { kind: "event", event: { type: "RUN_ERROR", message: "The agent process exited unexpectedly mid-task.", code: "agent_process_died" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getRunRetrying()).toBeNull();
    expect(agent.getRunError()).toMatch(/exited unexpectedly/);
    agent.dispose();
  });

  it("tracks the in-flight TOOL + run-start ts (so the UI can show what it's doing)", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1", ts: 1000 } },
      { kind: "event", event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" } },
      { kind: "synced" }, // synced while bash is mid-execution
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.runIsActive()).toBe(true);
    expect(agent.activeTool()).toBe("bash");
    expect(agent.runStartedAtMs()).toBe(1000);
    agent.dispose();
  });

  it("tracks CONTEXT_USAGE → contextFill fraction + token totals", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "CONTEXT_USAGE", usedTokens: 160_000, contextWindow: 200_000 } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.contextFill()).toBeCloseTo(0.8, 5);
    expect(agent.contextTokens()).toEqual({ used: 160_000, total: 200_000 });
    agent.dispose();
  });

  it("collects SYSTEM_MESSAGE events into getSystemMessages, anchored to the preceding message (deduped)", async () => {
    const frames = [
      // A system message before any real message has afterMessageId null.
      { kind: "event", event: { type: "SYSTEM_MESSAGE", messageId: "sys-0", source: "scheduler", text: "spawned" } },
      // A system message following a user turn anchors to u1.
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "u1" } },
      { kind: "event", event: { type: "SYSTEM_MESSAGE", messageId: "sys-1", source: "github", text: "PR #4 labeled" } },
      // A replayed duplicate (same id) must NOT double the list.
      { kind: "event", event: { type: "SYSTEM_MESSAGE", messageId: "sys-1", source: "github", text: "PR #4 labeled" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    const sys = agent.getSystemMessages();
    expect(sys).toHaveLength(2);
    expect(sys[0]).toEqual({ id: "sys-0", source: "scheduler", text: "spawned", afterMessageId: null });
    expect(sys[1]).toEqual({ id: "sys-1", source: "github", text: "PR #4 labeled", afterMessageId: "u1" });
    agent.dispose();
  });

  it("surfaces a SESSION_SEED as the session's seed, cleared by a fresh replay without one", async () => {
    const frames = [
      { kind: "event", event: { type: "SESSION_SEED", mode: "summary", parentId: "p1", parentTitle: "deploy pipeline", text: "the recap", summarizedTurns: 4 } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getSessionSeed()).toEqual({ parentId: "p1", parentTitle: "deploy pipeline", text: "the recap", summarizedTurns: 4 });
    agent.dispose();

    const blank = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c2", fetchImpl: sseFetch([{ kind: "synced" }]) });
    await foldTo(blank);
    expect(blank.getSessionSeed()).toBeNull();
    blank.dispose();
  });

  it("anchors a live SYSTEM_MESSAGE after a reload to the snapshot's last message, not before everything", async () => {
    // After a reload, history arrives folded into a MESSAGES_SNAPSHOT, so no TEXT_MESSAGE_START
    // flows; a live system message must still land after the newest message.
    const frames = [
      { kind: "event", event: { type: "MESSAGES_SNAPSHOT", messages: [
        { id: "u1", role: "user", content: "hi" },
        { id: "a1", role: "assistant", content: "hello" },
      ] } },
      { kind: "synced" },
      { kind: "event", event: { type: "SYSTEM_MESSAGE", messageId: "sys-1", source: "github", text: "PR #4 labeled" } },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getSystemMessages()).toEqual([
      { id: "sys-1", source: "github", text: "PR #4 labeled", afterMessageId: "a1" },
    ]);
    agent.dispose();
  });

  it("uses the server-stamped afterMessageId on replayed SYSTEM_MESSAGEs", async () => {
    const frames = [
      { kind: "event", event: { type: "MESSAGES_SNAPSHOT", messages: [
        { id: "u1", role: "user", content: "hi" },
        { id: "a1", role: "assistant", content: "hello" },
      ] } },
      { kind: "event", event: { type: "SYSTEM_MESSAGE", messageId: "sys-0", source: "scheduler", text: "spawned", afterMessageId: null } },
      { kind: "event", event: { type: "SYSTEM_MESSAGE", messageId: "sys-1", source: "github", text: "PR #4 labeled", afterMessageId: "u1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getSystemMessages().map((m) => [m.id, m.afterMessageId])).toEqual([["sys-0", null], ["sys-1", "u1"]]);
    agent.dispose();
  });

  it("clears the active tool on TOOL_CALL_END, and everything on RUN_FINISHED", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1", ts: 1000 } },
      { kind: "event", event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" } },
      { kind: "event", event: { type: "TOOL_CALL_END", toolCallId: "t1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.runIsActive()).toBe(true);
    expect(agent.activeTool()).toBeNull(); // between tool calls
    agent.dispose();
  });

  it("runIsActive() IGNORES out-of-band ext- runs (a broker interrupt isn't 'thinking')", async () => {
    const frames = [
      // An external interrupt run must not flip runIsActive on.
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
      // A new run begins, so the old error must not stick.
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
    // The latest snapshot wins.
    expect(agent.getQueuedMessages().map((m) => m.text)).toEqual(["queued A", "queued B"]);
    agent.dispose();
  });

  it("getQueuedMessages() clears when the queue drains (empty snapshot)", async () => {
    const frames = [
      { kind: "event", event: { type: "QUEUE_UPDATED", items: [{ id: "q1", text: "queued A", priority: 0 }] } },
      // The run pulled it out, so the queue is now empty.
      { kind: "event", event: { type: "QUEUE_UPDATED", items: [] } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getQueuedMessages()).toEqual([]);
    agent.dispose();
  });

  it("getQueuedMessages() is EMPTY once the run goes idle, even if the clearing snapshot was missed", async () => {
    // An idle run cannot hold a queued item, even if the clearing QUEUE_UPDATED([]) never arrived.
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "QUEUE_UPDATED", items: [{ id: "q1", text: "stuck follow-up", priority: 0 }] } },
      // The run finishes with no clearing QUEUE_UPDATED([]) after it.
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getQueuedMessages()).toEqual([]);
    agent.dispose();
  });

  it("IDLE WATCHDOG: a run stuck 'running' (dropped RUN_FINISHED) recovers via a forced reconnect", async () => {
    // Connection 1 streams RUN_STARTED then stays open and silent, so only a watchdog reconnect to connection 2 (which has RUN_FINISHED) can clear `running`.
    let conn = 0;
    // A never-closing body for connection 1.
    const stuckBody = () => {
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // deliberately not closed
        },
      });
    };
    // Connection 2: the full log, then close.
    const healedBody = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ].map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      if (conn === 1) return new Response(stuckBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(healedBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", fetchImpl,
      idleReconnectMs: 80, // tiny watchdog window
    });
    const stop = agent.renderPump();

    // Wait for the stuck connection to establish.
    await new Promise((r) => setTimeout(r, 60));
    expect(agent.runIsActive()).toBe(true);

    // The watchdog aborts connection 1 and the re-fold from connection 2 clears running.
    await new Promise((r) => setTimeout(r, 400));
    expect(conn).toBeGreaterThanOrEqual(2);
    expect(agent.runIsActive()).toBe(false);

    stop();
    agent.dispose();
  });

  it("IDLE WATCHDOG: a stuck pending interrupt (dropped PERMISSION_RESOLVED) heals via a forced reconnect", async () => {
    // With no active run, only the watchdog's pending-interrupt trigger can re-fold the dropped PERMISSION_RESOLVED.
    let conn = 0;
    const stuckBody = () => {
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          // An external interrupt, then silence with no run running.
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-1", outcome: { type: "interrupt", interrupts: [{ id: "aws1", reason: "confirmation", message: "approve AWS?" }] } } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // deliberately not closed
        },
      });
    };
    // Connection 2: the full log with the settling PERMISSION_RESOLVED.
    const healedBody = [
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-1", outcome: { type: "interrupt", interrupts: [{ id: "aws1", reason: "confirmation", message: "approve AWS?" }] } } },
      { kind: "event", event: { type: "PERMISSION_RESOLVED", toolCallId: "aws1", optionId: "approve" } },
      { kind: "synced" },
    ].map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      if (conn === 1) return new Response(stuckBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(healedBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", fetchImpl,
      idleReconnectMs: 80,
    });
    const stop = agent.renderPump();

    await new Promise((r) => setTimeout(r, 60));
    expect(agent.getPendingInterrupts().map((p) => p.id)).toContain("aws1");
    expect(agent.runIsActive()).toBe(false);

    await new Promise((r) => setTimeout(r, 400));
    expect(conn).toBeGreaterThanOrEqual(2);
    expect(agent.getPendingInterrupts().map((p) => p.id)).not.toContain("aws1");

    stop();
    agent.dispose();
  });

  it("IDLE WATCHDOG: a LEGITIMATELY pending interrupt does not churn reconnects forever (one-shot per set)", async () => {
    // The watchdog must re-fold at most once for a pending set the user has not answered.
    let conn = 0;
    const interruptFrame = { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-1", outcome: { type: "interrupt", interrupts: [{ id: "aws1", reason: "confirmation", message: "approve AWS?" }] } } };
    // Every connection serves the same still-pending log then stays open and silent.
    const pendingBody = () => {
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(interruptFrame)}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
        },
      });
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      return new Response(pendingBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl, idleReconnectMs: 80 });
    const stop = agent.renderPump();

    // Long enough for several watchdog windows to elapse.
    await new Promise((r) => setTimeout(r, 500));
    expect(agent.getPendingInterrupts().map((p) => p.id)).toContain("aws1");
    // The initial connection plus exactly one healing reconnect.
    expect(conn).toBe(2);

    stop();
    agent.dispose();
  });

  it("IDLE WATCHDOG: recovery heals the WHOLE UI surface at once (feed + running + queue + interrupts + error)", async () => {
    // Every live frame that would have cleared a field was dropped, so one watchdog reconnect must heal all of them together.
    let conn = 0;
    const stuckBody = () => {
      const enc = new TextEncoder();
      const frames = [
        // A first turn that must survive recovery.
        { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "list the files" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "u1" } },
        { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "here you go" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "a1" } },
        { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
        // A stale RUN_ERROR the next run should clear.
        { kind: "event", event: { type: "RUN_ERROR", message: "transient blip" } },
        // A second run, a queued follow-up and a permission interrupt.
        { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r2" } },
        { kind: "event", event: { type: "QUEUE_UPDATED", items: [{ id: "q1", text: "and then delete tmp", priority: 0 }] } },
        { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-1", outcome: { type: "interrupt", interrupts: [{ id: "perm1", reason: "confirmation", message: "ok to delete?" }] } } },
        { kind: "synced" },
        // The frames that would resolve r2, clear the queue and settle perm1 never arrive on this connection.
      ];
      return new ReadableStream({
        start(c) {
          for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
          // deliberately not closed
        },
      });
    };
    // Connection 2: the persisted log, fully resolved.
    const healedBody = [
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "list the files" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "u1" } },
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "here you go" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "a1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r2" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: "done, tmp deleted" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "a2" } },
      { kind: "event", event: { type: "PERMISSION_RESOLVED", toolCallId: "perm1", optionId: "allow" } },
      { kind: "event", event: { type: "QUEUE_UPDATED", items: [] } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r2" } },
      { kind: "synced" },
    ].map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      if (conn === 1) return new Response(stuckBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(healedBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl, idleReconnectMs: 80 });
    const stop = agent.renderPump();

    // Before recovery the UI is wedged on every front.
    await new Promise((r) => setTimeout(r, 60));
    const before = uiState(agent);
    expect(before.running).toBe(true);
    expect(before.queue).toEqual(["and then delete tmp"]);
    expect(before.interrupts).toContain("perm1");
    expect(before.feedText).toContain("here you go");

    // After the watchdog reconnect every field heals from the persisted log.
    await new Promise((r) => setTimeout(r, 400));
    const after = uiState(agent);
    expect(conn).toBeGreaterThanOrEqual(2);
    expect(after.running).toBe(false);
    expect(after.activeTool).toBeNull();
    expect(after.queue).toEqual([]);
    expect(after.interrupts).not.toContain("perm1");
    expect(after.runError).toBeNull();
    // The transcript is intact and grew by the second turn's reply.
    expect(after.feedText).toContain("here you go");
    expect(after.feedText).toContain("done, tmp deleted");

    stop();
    agent.dispose();
  });
  // --- the watchdog must fire on idle conversations too -----------

  it("IDLE DESYNC: a dropped stream on an IDLE conversation (running===false) forces a reconnect", async () => {
    // A stream that dies on an idle conversation must still be reconnected by the liveness check.
    let conn = 0;
    const idleDeadBody = () => {
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          // A complete, finished turn.
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "done" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // The stream then goes silent with no close and no heartbeats.
        },
      });
    };
    // Connection 2: the same history.
    const healedBody = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "done" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ].map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      if (conn === 1) return new Response(idleDeadBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(healedBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", fetchImpl,
      idleReconnectMs: 100,
    });
    const stop = agent.renderPump();

    // Wait for connection 1 to sync.
    await new Promise((r) => setTimeout(r, 60));
    expect(agent.runIsActive()).toBe(false);
    expect(agent.getPendingInterrupts()).toHaveLength(0);

    // Past the liveness window the watchdog must reconnect even with nothing running or pending.
    await new Promise((r) => setTimeout(r, 250));
    expect(conn).toBeGreaterThanOrEqual(2);

    stop();
    agent.dispose();
  });

  it("HEARTBEAT IS ACTIVITY: a quiet stream that receives ONLY heartbeats does NOT reconnect", async () => {
    // Only heartbeats arrive for several idle windows, and they must keep the stream alive.
    let conn = 0;
    const heartbeatBody = () => {
      const enc = new TextEncoder();
      let timer: any;
      let closeTimer: any;
      return new ReadableStream({
        start(c) {
          // Synced immediately with no history.
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // Then only heartbeats every 40ms.
          timer = setInterval(() => {
            c.enqueue(enc.encode(`: ping\n\n`));
          }, 40);
          // Keep the stream open for five idle windows.
          closeTimer = setTimeout(() => { clearInterval(timer); c.close(); }, 500);
        },
        cancel() {
          clearInterval(timer);
          clearTimeout(closeTimer);
        },
      });
    };

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      return new Response(heartbeatBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", fetchImpl,
      idleReconnectMs: 100,
    });
    const stop = agent.renderPump();

    // Wait several idle windows while heartbeats arrive.
    await new Promise((r) => setTimeout(r, 350));

    // The heartbeats kept the stream alive.
    expect(conn).toBe(1);

    stop();
    agent.dispose();
  });

  it("HEARTBEAT STOPS: when heartbeats STOP arriving, the watchdog reconnects EXACTLY ONCE", async () => {
    // Heartbeats stop without the connection closing, and the liveness check must fire exactly one reconnect.
    let conn = 0;
    const stalledBody = () => {
      const enc = new TextEncoder();
      let timer: any;
      return new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // Heartbeats for ~80ms, then silence.
          let count = 0;
          timer = setInterval(() => {
            if (count++ < 3) {
              c.enqueue(enc.encode(`: ping\n\n`));
            } else {
              clearInterval(timer); // stop sending without closing
            }
          }, 25);
        },
        cancel() {
          if (timer) clearInterval(timer);
        },
      });
    };
    const healedBody = [{ kind: "synced" }].map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      if (conn === 1) return new Response(stalledBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(healedBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", fetchImpl,
      idleReconnectMs: 100,
    });
    const stop = agent.renderPump();

    // Heartbeats stop at ~75ms and the liveness window is 240ms, so the reconnect lands at ~315ms.
    await new Promise((r) => setTimeout(r, 450));

    // Exactly one reconnect, not a storm.
    expect(conn).toBe(2);

    stop();
    agent.dispose();
  });

  it("POST-RECONNECT CONVERGENCE: the folded state matches the server log EXACTLY (same events, order, checksum)", async () => {
    // After a forced reconnect the folded state must equal the server's log exactly.
    let conn = 0;
    const partialBody = () => {
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          // Connection 1: partial history with no RUN_FINISHED.
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "partial…" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // The stream stalls here.
        },
      });
    };
    // Connection 2: the complete log.
    const completeLog = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "partial…" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: " complete now" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const completeBody = completeLog.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      if (conn === 1) return new Response(partialBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(completeBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", fetchImpl,
      idleReconnectMs: 100,
    });
    const stop = agent.renderPump();

    // Wait for connection 1's partial state.
    await new Promise((r) => setTimeout(r, 60));
    const partial = uiState(agent);
    expect(partial.running).toBe(true);
    expect(partial.feedText).toContain("partial…");
    expect(partial.feedText).not.toContain("complete now");

    // Wait for the reconnect and re-fold from the complete log.
    await new Promise((r) => setTimeout(r, 300));
    const converged = uiState(agent);
    expect(conn).toBe(2);
    expect(converged.running).toBe(false);
    expect(converged.feedText).toContain("partial… complete now");
    // The final text is neither doubled nor truncated.
    const messages = (agent as unknown as { messages: Array<{ content?: unknown }> }).messages;
    const finalContent = messages.map((m) => {
      const c = m.content;
      return typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "").join("") : "";
    }).join("");
    expect(finalContent).toBe("partial… complete now");

    stop();
    agent.dispose();
  });

  it("NO DUPLICATES ON RECONNECT: replay after reconnect does not double-apply already-folded events", async () => {
    // A replay after a mid-session reconnect must not double tool-call args or duplicate messages.
    let conn = 0;
    const log = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "running ls" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
      { kind: "event", event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" } },
      { kind: "event", event: { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"cmd":"ls"}' } },
      { kind: "event", event: { type: "TOOL_CALL_END", toolCallId: "t1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const body = log.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
    const stalled = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); /* not closed */ } });

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      if (conn === 1) return new Response(stalled(), { status: 200, headers: { "content-type": "text/event-stream" } });
      // Connection 2: the same log.
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", fetchImpl,
      idleReconnectMs: 100,
    });
    const stop = agent.renderPump();

    await new Promise((r) => setTimeout(r, 60)); // connection 1 folds
    await new Promise((r) => setTimeout(r, 300)); // reconnect and replay

    expect(conn).toBe(2);
    const messages = (agent as unknown as { messages: Array<{ toolCalls?: Array<{ function: { arguments: string } }> }> }).messages;
    const withTool = messages.filter((m) => (m.toolCalls?.length ?? 0) > 0);
    expect(withTool.length).toBe(1);
    expect(withTool[0].toolCalls![0].function.arguments).toBe('{"cmd":"ls"}');
    expect(messages.filter((m) => JSON.stringify(m).includes("bash")).length).toBe(1);

    stop();
    agent.dispose();
  });

  it("EVENTS WHILE DISCONNECTED ARE NOT LOST: append N events server-side during a drop, all N appear on reconnect", async () => {
    // The replay after a reconnect must contain every event appended during the drop, in order.
    let conn = 0;
    const initialLog = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "initial" } },
      { kind: "synced" },
    ];
    const initialBody = () => new ReadableStream({
      start(c) {
        for (const f of initialLog) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
        // The stream stalls here.
      },
    });

    // The server appended more events while the client was disconnected.
    const reconnectedLog = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "initial" } },
      // Appended while the client was disconnected.
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: " + new events" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
      { kind: "event", event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" } },
      { kind: "event", event: { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"cmd":"pwd"}' } },
      { kind: "event", event: { type: "TOOL_CALL_END", toolCallId: "t1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const reconnectedBody = reconnectedLog.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      if (conn === 1) return new Response(initialBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(reconnectedBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", fetchImpl,
      idleReconnectMs: 100,
    });
    const stop = agent.renderPump();

    await new Promise((r) => setTimeout(r, 60));
    const before = uiState(agent);
    expect(before.feedText).toContain("initial");
    expect(before.feedText).not.toContain("new events");

    await new Promise((r) => setTimeout(r, 300)); // reconnect
    const after = uiState(agent);
    expect(conn).toBe(2);
    expect(after.feedText).toContain("initial + new events");
    expect(after.running).toBe(false);
    const messages = (agent as unknown as { messages: Array<{ toolCalls?: Array<{ function: { name: string } }> }> }).messages;
    const tools = messages.flatMap((m) => m.toolCalls ?? []).map((tc) => tc.function.name);
    expect(tools).toContain("bash");

    stop();
    agent.dispose();
  });

  it("BACKGROUNDED TAB: visibilitychange forces a reconnect + resync when the tab becomes visible", async () => {
    // A backgrounded tab misses the watchdog window, so visibilitychange must force a reconnect.

    // A mock document for the Node test environment.
    const listeners = new Map<string, Set<EventListener>>();
    const mockDocument = {
      visibilityState: "hidden",
      addEventListener(type: string, listener: EventListener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent(event: Event) {
        listeners.get(event.type)?.forEach((l) => l(event));
        return true;
      },
    };
    const origDoc = (globalThis as any).document;
    (globalThis as any).document = mockDocument;

    let conn = 0;
    const stalledLog = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const stalledBody = () => new ReadableStream({
      start(c) {
        for (const f of stalledLog) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
        // The stream stalls while the tab is backgrounded.
      },
    });
    const freshLog = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "fresh state" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const freshBody = freshLog.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      if (conn === 1) return new Response(stalledBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(freshBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", fetchImpl,
      idleReconnectMs: 100,
    });
    const stop = agent.renderPump();

    await new Promise((r) => setTimeout(r, 60));
    const before = uiState(agent);
    expect(before.running).toBe(true);
    expect(before.feedText).not.toContain("fresh state");

    // The tab becomes visible.
    mockDocument.visibilityState = "visible";
    mockDocument.dispatchEvent(new Event("visibilitychange"));

    // Wait for the forced reconnect to complete.
    await new Promise((r) => setTimeout(r, 200));
    const after = uiState(agent);
    expect(conn).toBeGreaterThanOrEqual(2);
    expect(after.running).toBe(false);
    expect(after.feedText).toContain("fresh state");

    stop();
    agent.dispose();
    (globalThis as any).document = origDoc;
  });

  it("STREAM AUTH ERROR: a 401 on the stream surfaces getStreamAuthError() (not a silent retry loop), then self-clears on recovery", async () => {
    // An expired auth session 401s the stream, which must be surfaced rather than silently retried.
    let authValid = false; // starts expired
    const okBody = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ].map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (!authValid) return new Response("Unauthorized", { status: 401 });
      return new Response(okBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl, idleReconnectMs: 0 });
    const stop = agent.renderPump();

    await new Promise((r) => setTimeout(r, 60));
    expect(agent.getStreamAuthError()).toBe(true);

    // Once auth is renewed the next reconnect succeeds and the flag self-clears.
    authValid = true;
    await new Promise((r) => setTimeout(r, 5200)); // past the 5s auth back-off
    expect(agent.getStreamAuthError()).toBe(false);

    stop();
    agent.dispose();
  }, 8000);

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

  it("cancel() RETRIES a 404 through the assignment window, then succeeds", async () => {
    // Before the controller assigns an owner the cancel POST lands on a pod that answers 404, which retrying rides out.
    let calls = 0;
    const fetchSpy = vi.fn(async () => {
      calls++;
      return calls < 3 ? new Response("nf", { status: 404 }) : new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });
    await expect(agent.cancel()).resolves.toBeUndefined();
    expect(calls).toBe(3);
    agent.dispose();
  });

  it("cancel() still throws when the 404 persists (a truly deleted conversation)", async () => {
    const fetchSpy = vi.fn(async () => new Response("nf", { status: 404 })) as unknown as typeof fetch;
    // A compressed retry schedule keeps the attempt count within the unit-test budget.
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy, cancelRetryDelayMs: 5 });
    await expect(agent.cancel()).rejects.toThrow(/cancel request failed: 404/);
    expect(fetchSpy, "all 9 attempts must fire before giving up").toHaveBeenCalledTimes(9);
    agent.dispose();
  });

  it("cancel() does NOT retry a non-404 failure (a 500 throws immediately)", async () => {
    let calls = 0;
    const fetchSpy = vi.fn(async () => {
      calls++;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: fetchSpy });
    await expect(agent.cancel()).rejects.toThrow(/cancel request failed: 500/);
    expect(calls).toBe(1);
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

  // --- send() multimodal (stage 4) -------------------------------------------

  /** Capture the /agui POST body a send() produces. */
  function captureSend(): { fetchImpl: typeof fetch; body: () => any } {
    let captured: any;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/agui") && init?.method === "POST") {
        captured = JSON.parse(init.body as string);
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fetchImpl, body: () => captured };
  }

  it("send() with NO images posts content as a plain STRING (unchanged path)", async () => {
    const { fetchImpl, body } = captureSend();
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl });
    await agent.send("hello");
    expect(body().messages[0].content).toBe("hello");
    agent.dispose();
  });

  it("send() WITH images posts content as a text+image parts ARRAY", async () => {
    const { fetchImpl, body } = captureSend();
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl });
    await agent.send("what is this?", { images: [{ data: "QUJD", mimeType: "image/png" }] });
    const content = body().messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toContainEqual({ type: "text", text: "what is this?" });
    expect(content).toContainEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
    agent.dispose();
  });

  it("send() with an image but NO text omits the text part", async () => {
    const { fetchImpl, body } = captureSend();
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl });
    await agent.send("", { images: [{ data: "QUJD", mimeType: "image/png" }] });
    const content = body().messages[0].content;
    expect(content).toEqual([{ type: "image", data: "QUJD", mimeType: "image/png" }]);
    agent.dispose();
  });

  it("tracks a MESSAGE_IMAGES event from the stream -> getMessageImages (replay render)", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "see this" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "u1" } },
      {
        kind: "event",
        event: {
          type: "MESSAGE_IMAGES",
          messageId: "u1",
          images: [{ assetId: "a.png", mimeType: "image/png", url: "/conversations/c1/assets/a.png" }],
        },
      },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getMessageImages("u1")).toEqual([
      { assetId: "a.png", mimeType: "image/png", url: "/conversations/c1/assets/a.png" },
    ]);
    expect(agent.getMessageImages("nope")).toBeUndefined();
    agent.dispose();
  });

  it("records send times from opening events' ts and snapshot createdAt -> getMessageTime", async () => {
    const frames = [
      {
        kind: "event",
        event: {
          type: "MESSAGES_SNAPSHOT",
          messages: [
            { id: "old1", role: "user", content: "earlier", createdAt: 500 },
            { id: "old2", role: "assistant", content: "unstamped" },
          ],
        },
      },
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user", ts: 1000 } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi", ts: 1100 } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "u1", ts: 1200 } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant", ts: 2000 } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant", ts: 9999 } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getMessageTime("old1")).toBe(500);
    expect(agent.getMessageTime("old2")).toBeUndefined();
    expect(agent.getMessageTime("u1")).toBe(1000);
    // First write wins: a repeated start can't move the time.
    expect(agent.getMessageTime("a1")).toBe(2000);
    agent.dispose();
  });

  // --- the cluster's out-of-order tool-call shape --------------------------------
  //
  // The bridge surfaces the command as TOOL_CALL_ARGS after TOOL_CALL_END (goose's terminal-handoff shape), and the fold must survive that sequence.
  it("folds the cluster's exact sequence: TOOL_CALL_ARGS arriving AFTER TOOL_CALL_END", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "!echo zxcvbnm-marker" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "u1" } },
      { kind: "event", event: { type: "REASONING_START", messageId: "re1" } },
      { kind: "event", event: { type: "REASONING_MESSAGE_START", messageId: "re1", role: "reasoning" } },
      { kind: "event", event: { type: "REASONING_MESSAGE_CONTENT", messageId: "re1", delta: "Planning a response…" } },
      { kind: "event", event: { type: "REASONING_MESSAGE_END", messageId: "re1" } },
      { kind: "event", event: { type: "REASONING_END", messageId: "re1" } },
      { kind: "event", event: { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "run: echo zxcvbnm-marker" } },
      { kind: "event", event: { type: "TOOL_CALL_END", toolCallId: "call_1" } },
      { kind: "event", event: { type: "TOOL_CALL_ARGS", toolCallId: "call_1", delta: '{"command":"echo zxcvbnm-marker"}' } },
      { kind: "event", event: { type: "TOOL_CALL_RESULT", toolCallId: "call_1", messageId: "tr1", content: "zxcvbnm-marker" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "ran `echo zxcvbnm-marker` (exit 0)" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "a1" } },
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);

    const msgs = agent.messages as Array<{ role?: string; content?: unknown; toolCalls?: unknown[] }>;
    const withTool = msgs.filter((m) => (m.toolCalls?.length ?? 0) > 0);
    expect(withTool.length, "the tool call must survive the fold").toBeGreaterThan(0);
    expect(
      msgs.some((m) => m.role === "assistant" && JSON.stringify(m.content ?? "").includes("zxcvbnm-marker")),
      "the assistant reply must survive the fold",
    ).toBe(true);
    expect(agent.runIsActive(), "RUN_FINISHED must end the run").toBe(false);
    agent.dispose();
  });

  // The same sequence delivered live after an immediate `synced`, paced, on a stream that never closes.
  it("folds the same sequence delivered LIVE after synced, paced, on an open stream", async () => {
    const events = [
      { type: "RUN_STARTED", threadId: "c1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "!echo zxcvbnm-marker" },
      { type: "TEXT_MESSAGE_END", messageId: "u1" },
      { type: "REASONING_START", messageId: "re1" },
      { type: "REASONING_MESSAGE_START", messageId: "re1", role: "reasoning" },
      { type: "REASONING_MESSAGE_CONTENT", messageId: "re1", delta: "Planning a response…" },
      { type: "REASONING_MESSAGE_END", messageId: "re1" },
      { type: "REASONING_END", messageId: "re1" },
      { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "run: echo zxcvbnm-marker" },
      { type: "TOOL_CALL_END", toolCallId: "call_1" },
      { type: "TOOL_CALL_ARGS", toolCallId: "call_1", delta: '{"command":"echo zxcvbnm-marker"}' },
      { type: "TOOL_CALL_RESULT", toolCallId: "call_1", messageId: "tr1", content: "zxcvbnm-marker" },
      { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "ran `echo zxcvbnm-marker` (exit 0)" },
      { type: "TEXT_MESSAGE_END", messageId: "a1" },
      { type: "RUN_FINISHED", threadId: "c1", runId: "r1" },
    ];
    const enc = new TextEncoder();
    const liveFetch = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(enc.encode('data: {"kind":"synced"}\n\n')); // caught up on an empty log
          for (const e of events) {
            await new Promise((r) => setTimeout(r, 25)); // paced, like a live run
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: e })}\n\n`));
          }
          controller.enqueue(enc.encode(": ping\n\n"));
          // A live stream never closes.
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: liveFetch });
    const stop = agent.renderPump();
    // Wait for the paced delivery to complete, then settle.
    await new Promise((r) => setTimeout(r, 25 * events.length + 600));

    const msgs = agent.messages as Array<{ role?: string; content?: unknown; toolCalls?: unknown[] }>;
    const withTool = msgs.filter((m) => (m.toolCalls?.length ?? 0) > 0);
    expect(withTool.length, "the tool call must survive LIVE delivery").toBeGreaterThan(0);
    expect(
      msgs.some((m) => m.role === "assistant" && JSON.stringify(m.content ?? "").includes("zxcvbnm-marker")),
      "the assistant reply must survive LIVE delivery",
    ).toBe(true);
    expect(agent.runIsActive(), "RUN_FINISHED must end the run on the LIVE path").toBe(false);
    stop();
    agent.dispose();
  });

});

describe("seedTail + full replay must not leave DUPLICATE message ids", () => {
  it("the seeded tail is not double-counted by the replay that follows it", async () => {
    // The seeded-first-connection path keeps the painted tail instead of resetting to empty, and duplicate ids would crash the message repository.
    const tail = [
      { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hello" },
      { type: "TEXT_MESSAGE_END", messageId: "u1" },
      { type: "RUN_FINISHED", threadId: "c1", runId: "r0" },
    ];
    // The full replay contains the same turn, since the tail is a suffix of the log.
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r0" } },
      ...tail.map((event) => ({ kind: "event", event })),
      { kind: "synced" },
    ];

    const agent = createIntegrityAgent({
      baseUrl: "http://host",
      conversationId: "c1",
      fetchImpl: sseFetch(frames, tail),
    });

    const stop = agent.renderPump();
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => { unsubscribe(); stop(); resolve(); };
      const { unsubscribe } = agent.subscribe({
        onMessagesChanged: () => {
          clearTimeout(timer);
          timer = setTimeout(done, 200);
        },
      });
      setTimeout(done, 1500);
    });

    const ids = (agent.messages as Array<{ id?: string }>).map((m) => m.id).filter(Boolean);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(
      dupes,
      `duplicate message ids reach the repository and CRASH the thread: ${JSON.stringify(ids)}`,
    ).toEqual([]);
  });
});

describe("an UNCREATED conversation never reaches the server", () => {
  it("renderPump does NOT open a stream while conversationId is undefined", async () => {
    // Streaming a local placeholder would 404 and reconnect in a loop.
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const agent = createIntegrityAgent({
      baseUrl: "http://host",
      conversationId: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const stop = agent.renderPump();
    await new Promise((r) => setTimeout(r, 120));
    stop();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("send() REFUSES rather than posting to a placeholder", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const agent = createIntegrityAgent({
      baseUrl: "http://host",
      conversationId: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(agent.send("hello")).rejects.toThrow(/not been created/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("starts streaming once the server id arrives", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const agent = createIntegrityAgent({
      baseUrl: "http://host",
      conversationId: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const stop = agent.renderPump();
    await new Promise((r) => setTimeout(r, 60));
    expect(fetchImpl).not.toHaveBeenCalled();

    agent.setConversationId("server-1");
    await new Promise((r) => setTimeout(r, 400));
    stop();

    expect(fetchImpl).toHaveBeenCalled();
    // Every request the pump makes must name the server id, never the local key.
    const urls = fetchImpl.mock.calls.map((c) => String((c as unknown[])[0]));
    for (const u of urls) expect(u).toContain("/conversations/server-1/");
    expect(urls.some((u) => u.includes("/events.integrity"))).toBe(true);
  });
});
