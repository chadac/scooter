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

/** A fetch stub that serves the scripted frames as an SSE ReadableStream. */
function sseFetch(frames: unknown[]): typeof fetch {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return vi.fn(async () => {
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
    expect((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls.length, "one fetch per fold").toBe(1);

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
});
