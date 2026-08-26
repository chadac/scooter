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

/** A full snapshot of the UI-visible surface an IntegrityAgent drives, so a
 *  recovery test can assert the WHOLE state healed (chat feed + queue + running +
 *  interrupts + error), not just one field. `feed` is the folded message text so a
 *  test can prove the transcript itself is intact after a reconnect. */
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

  it("send() cancels the POST /agui response body (frees the HTTP/2 flow-control window)", async () => {
    // POST /agui is itself an SSE endpoint: the server streams the whole run's
    // events into the response until RUN_FINISHED. We drive the render off the
    // integrity stream instead, so we must NOT leave this body unread — an
    // unconsumed body fills the per-stream (and then connection-level) HTTP/2
    // window and stalls OTHER streams on the same connection (notably
    // events.integrity). The fix cancels the body once the POST is accepted.
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
    expect(agent.getRunRetrying()).toBeNull(); // cleared — no longer showing "retrying…"
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
    expect(agent.getRunRetrying()).toBeNull(); // no longer retrying
    expect(agent.getRunError()).toMatch(/exited unexpectedly/); // the terminal error stands
    agent.dispose();
  });

  it("tracks the in-flight TOOL + run-start ts (so the UI can show what it's doing)", async () => {
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1", ts: 1000 } },
      { kind: "event", event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" } },
      { kind: "synced" }, // synced while bash is mid-execution (the stuck-on-a-tool case)
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
      // A system message BEFORE any real message → afterMessageId null.
      { kind: "event", event: { type: "SYSTEM_MESSAGE", messageId: "sys-0", source: "scheduler", text: "spawned" } },
      // A real user turn, then a system message that followed it → anchored to u1.
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
    expect(agent.activeTool()).toBeNull(); // between tool calls — running, but no tool
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

  it("getQueuedMessages() is EMPTY once the run goes idle, even if the clearing snapshot was missed", async () => {
    // The reported "message stuck in the queue" bug: a QUEUE_UPDATED with an item
    // arrives, then the run FINISHES, but the clearing QUEUE_UPDATED([]) never
    // reached the live client. An idle run cannot hold a queued item (the queue
    // only has items WHILE a run is draining them), so the UI must show it empty.
    const frames = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "QUEUE_UPDATED", items: [{ id: "q1", text: "stuck follow-up", priority: 0 }] } },
      // Run finishes — no clearing QUEUE_UPDATED([]) follows (the missed-snapshot case).
      { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
      { kind: "synced" },
    ];
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(frames) });
    await foldTo(agent);
    expect(agent.getQueuedMessages()).toEqual([]); // no phantom — the run is idle
    agent.dispose();
  });

  it("IDLE WATCHDOG: a run stuck 'running' (dropped RUN_FINISHED) recovers via a forced reconnect", async () => {
    // The "agent seems dead" repro: connection 1 streams RUN_STARTED then goes
    // SILENT (the live RUN_FINISHED was dropped) with the stream held open, so
    // `running` sticks true forever. The idle-watchdog forces a reconnect; the
    // re-fold from the log (connection 2, which HAS RUN_FINISHED) heals `running`.
    let conn = 0;
    // A never-closing body for connection 1 (stream stays open, no terminal event).
    const stuckBody = () => {
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // deliberately DO NOT close — the connection stays open + silent.
        },
      });
    };
    // Connection 2: the full, correct log (RUN_STARTED + RUN_FINISHED), then close.
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
      idleReconnectMs: 80, // tiny watchdog so the test doesn't wait 25s
    });
    const stop = agent.renderPump();

    // Wait for the stuck connection to establish (running=true).
    await new Promise((r) => setTimeout(r, 60));
    expect(agent.runIsActive()).toBe(true); // stuck "running"

    // The watchdog fires (~80ms idle) -> aborts conn 1 -> reconnects (conn 2) ->
    // re-folds the log with RUN_FINISHED -> running clears.
    await new Promise((r) => setTimeout(r, 400));
    expect(conn).toBeGreaterThanOrEqual(2); // a reconnect happened
    expect(agent.runIsActive()).toBe(false); // healed

    stop();
    agent.dispose();
  });

  it("IDLE WATCHDOG: a stuck pending interrupt (dropped PERMISSION_RESOLVED) heals via a forced reconnect", async () => {
    // A broker/external interrupt is settled ONLY by PERMISSION_RESOLVED. If that
    // live frame is dropped, the approval sticks forever with NO active run to
    // re-arm a reconnect. The watchdog also triggers on a stale PENDING INTERRUPT
    // (once per pending set) so the re-fold from the log — which HAS the
    // PERMISSION_RESOLVED — clears it.
    let conn = 0;
    const stuckBody = () => {
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          // An external interrupt raised, then the stream goes silent (the settling
          // PERMISSION_RESOLVED was dropped). No RUN is running.
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-1", outcome: { type: "interrupt", interrupts: [{ id: "aws1", reason: "confirmation", message: "approve AWS?" }] } } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // deliberately DO NOT close.
        },
      });
    };
    // Connection 2: the full log, now WITH the settling PERMISSION_RESOLVED.
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
    expect(agent.getPendingInterrupts().map((p) => p.id)).toContain("aws1"); // stuck approval
    expect(agent.runIsActive()).toBe(false); // NOT running — only the interrupt is stuck

    await new Promise((r) => setTimeout(r, 400));
    expect(conn).toBeGreaterThanOrEqual(2); // a reconnect happened
    expect(agent.getPendingInterrupts().map((p) => p.id)).not.toContain("aws1"); // healed

    stop();
    agent.dispose();
  });

  it("IDLE WATCHDOG: a LEGITIMATELY pending interrupt does not churn reconnects forever (one-shot per set)", async () => {
    // A real approval the user hasn't answered stays pending in the log across a
    // re-fold. The watchdog must re-fold at most ONCE for that pending set — never
    // reconnect every T seconds while the user decides (that would thrash the log).
    let conn = 0;
    const interruptFrame = { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-1", outcome: { type: "interrupt", interrupts: [{ id: "aws1", reason: "confirmation", message: "approve AWS?" }] } } };
    // Every connection serves the SAME still-pending log then stays open + silent.
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

    // Give it long enough for MANY watchdog windows (5+ at 80ms) to elapse.
    await new Promise((r) => setTimeout(r, 500));
    expect(agent.getPendingInterrupts().map((p) => p.id)).toContain("aws1"); // still pending (real approval)
    // One-shot: exactly ONE healing reconnect for the pending set (conn 1 initial +
    // conn 2 the single re-fold). NOT a reconnect every window.
    expect(conn).toBe(2);

    stop();
    agent.dispose();
  });

  it("IDLE WATCHDOG: recovery heals the WHOLE UI surface at once (feed + running + queue + interrupts + error)", async () => {
    // A realistic 'agent seemed dead' snapshot: the live stream shows a completed
    // first turn, a SECOND run in flight (RUN_STARTED), a phantom queued follow-up,
    // a stale error banner, AND a stuck interrupt — because the live frames that
    // would have cleared each (RUN_FINISHED, QUEUE_UPDATED([]), the next
    // RUN_STARTED, PERMISSION_RESOLVED) were all dropped. One watchdog reconnect
    // re-folds the persisted log and every field must heal together.
    let conn = 0;
    const stuckBody = () => {
      const enc = new TextEncoder();
      const frames = [
        // First turn: a real user message + assistant reply (must SURVIVE recovery).
        { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "list the files" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "u1" } },
        { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "here you go" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "a1" } },
        { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
        // A stale RUN_ERROR the NEXT run should clear (self-heal class).
        { kind: "event", event: { type: "RUN_ERROR", message: "transient blip" } },
        // Second run starts + a follow-up queues behind it + a permission interrupt.
        { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r2" } },
        { kind: "event", event: { type: "QUEUE_UPDATED", items: [{ id: "q1", text: "and then delete tmp", priority: 0 }] } },
        { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "ext-1", outcome: { type: "interrupt", interrupts: [{ id: "perm1", reason: "confirmation", message: "ok to delete?" }] } } },
        { kind: "synced" },
        // ...then the stream goes SILENT. The frames that would resolve r2 +
        // clear the queue + settle perm1 never arrive on this connection.
      ];
      return new ReadableStream({
        start(c) {
          for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
          // deliberately DO NOT close.
        },
      });
    };
    // Connection 2 — the PERSISTED log, fully resolved: r2 finished, the queue
    // cleared, the error superseded, the permission settled.
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

    // BEFORE recovery: the UI is visibly wedged on multiple fronts.
    await new Promise((r) => setTimeout(r, 60));
    const before = uiState(agent);
    expect(before.running).toBe(true);                    // r2 stuck running
    expect(before.queue).toEqual(["and then delete tmp"]); // phantom queue
    expect(before.interrupts).toContain("perm1");          // stuck approval
    expect(before.feedText).toContain("here you go");      // first turn present

    // AFTER the watchdog reconnect: EVERY field heals from the persisted log.
    await new Promise((r) => setTimeout(r, 400));
    const after = uiState(agent);
    expect(conn).toBeGreaterThanOrEqual(2);                // a reconnect happened
    expect(after.running).toBe(false);                     // r2 finished
    expect(after.activeTool).toBeNull();
    expect(after.queue).toEqual([]);                       // queue cleared
    expect(after.interrupts).not.toContain("perm1");       // approval settled
    expect(after.runError).toBeNull();                     // error superseded
    // The transcript is intact AND grew (the second turn's reply is now folded).
    expect(after.feedText).toContain("here you go");
    expect(after.feedText).toContain("done, tmp deleted");

    stop();
    agent.dispose();
  });
  // --- IDLE DESYNC BUG: watchdog must fire on IDLE conversations too -----------

  it("IDLE DESYNC: a dropped stream on an IDLE conversation (running===false) forces a reconnect", async () => {
    // THE REPORTED BUG: conversation is IDLE (no run in-flight, no pending
    // interrupt), the stream dies (e.g. ingress restart), and the UI never
    // reconnects because the watchdog only checked `running || interruptStuck`.
    // This test MUST FAIL before the fix.
    let conn = 0;
    const idleDeadBody = () => {
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          // A complete, finished turn — running===false.
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "done" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // Stream is now synced + idle (running===false, no interrupts) and DIES
          // (deliberately do NOT close or send heartbeats — simulates a silent drop).
        },
      });
    };
    // Connection 2: same history, proves reconnect happened.
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
      idleReconnectMs: 100, // liveness window: reconnect if NO frame for >100ms
    });
    const stop = agent.renderPump();

    // Wait for connection 1 to sync (idle, running===false).
    await new Promise((r) => setTimeout(r, 60));
    expect(agent.runIsActive()).toBe(false); // idle
    expect(agent.getPendingInterrupts()).toHaveLength(0); // no approvals

    // Wait past the liveness window (>100ms of silence) — the watchdog MUST
    // reconnect even though running===false and no interrupts are pending.
    await new Promise((r) => setTimeout(r, 250));
    expect(conn).toBeGreaterThanOrEqual(2); // reconnect happened (FAILS before fix)

    stop();
    agent.dispose();
  });

  it("HEARTBEAT IS ACTIVITY: a quiet stream that receives ONLY heartbeats does NOT reconnect", async () => {
    // Defect 2 guard: if we fix "heartbeats count as activity" but break the
    // liveness check, a healthy quiet stream churns reconnects every window.
    // Feed ONLY `: ping\n\n` (no data: frames) for 3× the idle window — assert
    // NO reconnect (the heartbeats keep it alive). MUST FAIL if heartbeats don't
    // reset the activity clock.
    let conn = 0;
    const heartbeatBody = () => {
      const enc = new TextEncoder();
      let timer: any;
      let closeTimer: any;
      return new ReadableStream({
        start(c) {
          // Synced immediately (no history).
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // Then ONLY heartbeats (`: ping\n\n`) every 40ms, no events.
          timer = setInterval(() => {
            c.enqueue(enc.encode(`: ping\n\n`));
          }, 40);
          // Keep the stream open for ~500ms (5× the 100ms window).
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
      idleReconnectMs: 100, // liveness: reconnect if NO frame for >100ms
    });
    const stop = agent.renderPump();

    // Wait 3× the idle window (heartbeats are arriving every 40ms).
    await new Promise((r) => setTimeout(r, 350));

    // NO reconnect — the heartbeats kept the stream alive.
    expect(conn).toBe(1); // FAILS if heartbeats don't count as activity

    stop();
    agent.dispose();
  });

  it("HEARTBEAT STOPS: when heartbeats STOP arriving, the watchdog reconnects EXACTLY ONCE", async () => {
    // Heartbeats arrive normally, then STOP (simulates a stalled connection that
    // never closes). The liveness check must fire EXACTLY ONE reconnect — not a
    // storm, and not zero (the stream is dead).
    let conn = 0;
    const stalledBody = () => {
      const enc = new TextEncoder();
      let timer: any;
      return new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // Heartbeats for ~80ms, then SILENCE (stalled connection).
          let count = 0;
          timer = setInterval(() => {
            if (count++ < 3) {
              c.enqueue(enc.encode(`: ping\n\n`));
            } else {
              clearInterval(timer); // stop sending, but DO NOT close
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

    // Wait long enough for the heartbeats to stop + the liveness window to expire.
    // Heartbeats run for 3×25ms = 75ms, then stop. Liveness window = 100×2.4 = 240ms.
    // So reconnect should happen at ~75+240 = 315ms. Wait 450ms to be safe.
    await new Promise((r) => setTimeout(r, 450));

    // EXACTLY ONE reconnect (conn 1 stalled → conn 2), not a storm.
    expect(conn).toBe(2);

    stop();
    agent.dispose();
  });

  it("POST-RECONNECT CONVERGENCE: the folded state matches the server log EXACTLY (same events, order, checksum)", async () => {
    // The most important test: after ANY forced reconnect (idle desync, stalled
    // heartbeat, whatever), the client's folded state must equal the server's
    // authoritative log EXACTLY — same event set, same order, same final message
    // content. Not "it reconnected" — "it CONVERGED".
    let conn = 0;
    const partialBody = () => {
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          // Connection 1: partial history (RUN_STARTED, partial message, NO RUN_FINISHED).
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "partial…" } })}\n\n`));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ kind: "synced" })}\n\n`));
          // Stream stalls (no RUN_FINISHED, no more content).
        },
      });
    };
    // Connection 2: the FULL, COMPLETE log from the server.
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

    // Wait for connection 1 (partial state).
    await new Promise((r) => setTimeout(r, 60));
    const partial = uiState(agent);
    expect(partial.running).toBe(true); // stuck mid-run
    expect(partial.feedText).toContain("partial…");
    expect(partial.feedText).not.toContain("complete now"); // missing tail

    // Wait for reconnect + re-fold from the complete log.
    await new Promise((r) => setTimeout(r, 300));
    const converged = uiState(agent);
    expect(conn).toBe(2); // reconnected
    // CONVERGENCE: the folded state now matches the server's complete log.
    expect(converged.running).toBe(false); // RUN_FINISHED applied
    expect(converged.feedText).toContain("partial… complete now"); // FULL content
    // The final message text is EXACTLY what the server log contains (not doubled,
    // not truncated).
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
    // The server dedups by checksum (each event has one). Assert a replay after
    // reconnect does not double tool-call args or duplicate messages — the
    // page-refresh replay bug guard, but for a mid-session reconnect.
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
    const stalled = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); /* DO NOT close */ } });

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/tail")) {
        return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      conn += 1;
      if (conn === 1) return new Response(stalled(), { status: 200, headers: { "content-type": "text/event-stream" } });
      // Connection 2: the SAME log (a replay).
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const agent = createIntegrityAgent({
      baseUrl: "http://host", conversationId: "c1", fetchImpl,
      idleReconnectMs: 100,
    });
    const stop = agent.renderPump();

    await new Promise((r) => setTimeout(r, 60)); // connection 1 folds
    await new Promise((r) => setTimeout(r, 300)); // reconnect + replay

    expect(conn).toBe(2); // reconnected
    // NO DOUBLE-APPLICATION: tool args are NOT doubled.
    const messages = (agent as unknown as { messages: Array<{ toolCalls?: Array<{ function: { arguments: string } }> }> }).messages;
    const withTool = messages.filter((m) => (m.toolCalls?.length ?? 0) > 0);
    expect(withTool.length).toBe(1);
    expect(withTool[0].toolCalls![0].function.arguments).toBe('{"cmd":"ls"}'); // NOT '{"cmd":"ls"}{"cmd":"ls"}'
    // Exactly ONE assistant message with the tool call (not two).
    expect(messages.filter((m) => JSON.stringify(m).includes("bash")).length).toBe(1);

    stop();
    agent.dispose();
  });

  it("EVENTS WHILE DISCONNECTED ARE NOT LOST: append N events server-side during a drop, all N appear on reconnect", async () => {
    // The server keeps appending events to the log while a client is disconnected.
    // On reconnect, the replay MUST contain ALL those events (in order), not just
    // the ones the client saw before the drop.
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
        // Stream stalls (no close).
      },
    });

    // While disconnected, the server appended MORE events to the log (a tool call).
    const reconnectedLog = [
      { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
      { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "initial" } },
      // NEW events appended while the client was disconnected:
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
    expect(before.feedText).not.toContain("new events"); // not yet

    await new Promise((r) => setTimeout(r, 300)); // reconnect
    const after = uiState(agent);
    expect(conn).toBe(2);
    // ALL new events appeared, in order.
    expect(after.feedText).toContain("initial + new events");
    expect(after.running).toBe(false); // RUN_FINISHED applied
    const messages = (agent as unknown as { messages: Array<{ toolCalls?: Array<{ function: { name: string } }> }> }).messages;
    const tools = messages.flatMap((m) => m.toolCalls ?? []).map((tc) => tc.function.name);
    expect(tools).toContain("bash"); // the new tool call appeared

    stop();
    agent.dispose();
  });

  it("BACKGROUNDED TAB: visibilitychange forces a reconnect + resync when the tab becomes visible", async () => {
    // Browsers throttle background-tab timers, so a backgrounded tab misses the
    // watchdog window entirely. A visibilitychange handler must force a
    // reconnect-and-refold when the tab becomes visible so the user sees current
    // state, not stale pre-background state. This test will FAIL until F3 is
    // implemented.

    // Mock document for Node test environment
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
        // Stream stalls (simulates: tab was backgrounded, stream went silent, tab now foreground again).
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
    expect(before.running).toBe(true); // stale (stuck mid-run)
    expect(before.feedText).not.toContain("fresh state");

    // Simulate the tab becoming visible (fire visibilitychange).
    // The agent MUST listen for this and force a reconnect.
    mockDocument.visibilityState = "visible";
    mockDocument.dispatchEvent(new Event("visibilitychange"));

    // Wait for the forced reconnect to complete.
    await new Promise((r) => setTimeout(r, 200));
    const after = uiState(agent);
    expect(conn).toBeGreaterThanOrEqual(2); // visibilitychange forced a reconnect (FAILS before F3)
    expect(after.running).toBe(false); // fresh state from the log
    expect(after.feedText).toContain("fresh state");

    stop();
    agent.dispose();
    (globalThis as any).document = origDoc;
  });

  it("STREAM AUTH ERROR: a 401 on the stream surfaces getStreamAuthError() (not a silent retry loop), then self-clears on recovery", async () => {
    // An expired ingress/auth session in front of the agent-host makes the stream
    // 401. The UI must SURFACE this durably (so it can show a banner) instead of
    // silently reconnecting forever pretending the agent is alive.
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

    // The auth error is surfaced (not silently swallowed).
    await new Promise((r) => setTimeout(r, 60));
    expect(agent.getStreamAuthError()).toBe(true);

    // Auth renewed (the ingress refreshed the session) — the next reconnect
    // succeeds and the flag self-clears, no reload required.
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
});

describe("seedTail + full replay must not leave DUPLICATE message ids", () => {
  it("the seeded tail is not double-counted by the replay that follows it", async () => {
    // REGRESSION GUARD for the white-screen crash (MessageRepository performOp/link:
    // "A message with the same id already exists in the parent tree"), which unmounts
    // <ConversationRuntime> and blanks the whole page.
    //
    // This exercises the seeded-first-connection path, which NO other test covers: the
    // rest pass no tailEvents, so seedTail no-ops. renderPump folds every physical
    // connection "seeded from an EMPTY message list" so the replay rebuilds rather than
    // doubles — but the `firstConn && seeded` branch exempts itself (a raw
    // `this.messages = []` instead of setMessages([])) to avoid flashing the fast first
    // paint away.
    //
    // NOTE: this path was a SUSPECT for the duplicate and is NOT the culprit — this test
    // passes today. Keeping it as a guard: the exemption is genuinely subtle, it is the
    // one place the "always fold from empty" invariant is deliberately broken, and it was
    // previously untested. The actual source of the duplicate seen on CI is still
    // unidentified; toRepositorySnapshot now dedupes so it cannot crash the thread.
    const tail = [
      { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hello" },
      { type: "TEXT_MESSAGE_END", messageId: "u1" },
      { type: "RUN_FINISHED", threadId: "c1", runId: "r0" },
    ];
    // The full replay contains that SAME turn (the tail is a suffix of the log).
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
    // The reported bug: the pump streamed a local placeholder, 404'd, and reconnected
    // three times in four seconds — which produced a duplicate start whose dangling run
    // injected a spurious "interrupted by a restart" message.
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
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/conversations/server-1/events.integrity");
  });
});
