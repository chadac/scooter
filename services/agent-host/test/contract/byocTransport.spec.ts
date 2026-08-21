/**
 * Tier 1 contract — the BYOC transport (increment 4 of todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §M).
 *
 * This is the swap that deletes the bug class. Before: each agent-host pod held the container's
 * WebSocket in its own memory, so only the pod the container happened to reach could drive that
 * brain — one user's conversations spread across replicas would half-work, which is the same shape
 * as the conversation-list bug in #284.
 *
 * After: the pod holds NOTHING. It POSTs a prompt to the BYOC controller and reads the ACP frames
 * back as SSE; the controller owns the single socket. Any replica can serve any conversation, and a
 * rollout cannot strand a run.
 *
 * The seam is `RemoteTransport` (send / onFrame / isOpen / onClose / close), which RemoteAcpClient
 * already drives — so this is a TRANSPORT swap, not a rewrite of the ACP client. What matters is
 * that the HTTP/SSE implementation honours the same contract, especially the failure modes: a
 * transport that goes quiet instead of closing leaves the bridge waiting on an ack forever.
 */

import { describe, it, expect, vi } from "vitest";

import { createByocTransport } from "../../src/acp/byocTransport.js";
import type { WireFrame } from "../../src/acp/remoteProtocol.js";

/** Build a fetch that answers the prompt POST with an SSE body of `frames`, and records requests. */
function sseFetch(frames: WireFrame[], opts: { status?: number; hang?: boolean } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (opts.status && opts.status >= 400) {
      return new Response(JSON.stringify({ error: "nope" }), { status: opts.status });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
        }
        if (!opts.hang) controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PROMPT: WireFrame = { ch: "acp", type: "prompt", id: "r1", payload: { sessionId: "s1", prompt: [] } };

describe("BYOC transport (agent-host -> controller over HTTP/SSE)", () => {
  it("send() POSTs the frame to the controller's prompt endpoint for THIS session", async () => {
    const { impl, calls } = sseFetch([]);
    const t = createByocTransport({ baseUrl: "http://byoc:8080", sessionId: "sess-1", fetchImpl: impl });
    t.send(PROMPT);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("http://byoc:8080/byoc/sess-1/prompt");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ ch: "acp", type: "prompt" });
  });

  it("frames from the SSE response dispatch to onFrame subscribers, in order", async () => {
    const frames: WireFrame[] = [
      { ch: "acp", type: "session_update", payload: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } } } },
      { ch: "acp", type: "session_update", payload: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } } } },
      { ch: "acp", type: "ack", id: "r1", payload: { result: { stopReason: "end_turn" } } },
    ];
    const { impl } = sseFetch(frames);
    const t = createByocTransport({ baseUrl: "http://byoc:8080", sessionId: "sess-1", fetchImpl: impl });
    const seen: WireFrame[] = [];
    t.onFrame((f) => seen.push(f));
    t.send(PROMPT);
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen.map((f) => f.type)).toEqual(["session_update", "session_update", "ack"]);
  });

  it("a permission answer is POSTed to the permission endpoint, not the prompt endpoint", async () => {
    const { impl, calls } = sseFetch([]);
    const t = createByocTransport({ baseUrl: "http://byoc:8080", sessionId: "sess-1", fetchImpl: impl });
    // An ACP `ack` whose id matches a permission the container is blocked on is an ANSWER going
    // back down — it must not be posted as a new prompt (which would start a second run).
    t.send({ ch: "acp", type: "ack", id: "perm-1", payload: { optionId: "allow" } });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("http://byoc:8080/byoc/sess-1/permission/perm-1");
  });

  it("an exec result is POSTed to the exec endpoint (Channel B replies travel their own route)", async () => {
    const { impl, calls } = sseFetch([]);
    const t = createByocTransport({ baseUrl: "http://byoc:8080", sessionId: "sess-1", fetchImpl: impl });
    t.send({ ch: "exec", type: "exec_result", id: "x-1", payload: { result: { stdout: "ok", stderr: "", exitCode: 0 } } });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("http://byoc:8080/byoc/sess-1/exec/x-1");
  });

  it("a NON-OK response closes the transport so the bridge surfaces RUN_ERROR (never a silent stall)", async () => {
    const { impl } = sseFetch([], { status: 503 });
    const t = createByocTransport({ baseUrl: "http://byoc:8080", sessionId: "sess-1", fetchImpl: impl });
    const onClose = vi.fn();
    t.onClose(onClose);
    t.send(PROMPT);
    // The controller answers 503 when the container is not connected. If the transport just went
    // quiet here, RemoteAcpClient would wait on an ack that can never arrive and the user would
    // watch a spinner forever.
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(t.isOpen()).toBe(false);
  });

  it("a fetch REJECTION (controller unreachable) also closes the transport", async () => {
    const impl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const t = createByocTransport({ baseUrl: "http://byoc:8080", sessionId: "sess-1", fetchImpl: impl });
    const onClose = vi.fn();
    t.onClose(onClose);
    t.send(PROMPT);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("close() stops dispatching frames from an in-flight stream", async () => {
    const frames: WireFrame[] = [{ ch: "acp", type: "ack", id: "r1", payload: {} }];
    const { impl } = sseFetch(frames, { hang: true });
    const t = createByocTransport({ baseUrl: "http://byoc:8080", sessionId: "sess-1", fetchImpl: impl });
    const seen: WireFrame[] = [];
    t.onFrame((f) => seen.push(f));
    t.close();
    t.send(PROMPT);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(0);
    expect(t.isOpen()).toBe(false);
  });

  it("onFrame's unsubscribe actually stops delivery", async () => {
    const { impl } = sseFetch([{ ch: "acp", type: "ack", id: "r1", payload: {} }]);
    const t = createByocTransport({ baseUrl: "http://byoc:8080", sessionId: "sess-1", fetchImpl: impl });
    const seen: WireFrame[] = [];
    const off = t.onFrame((f) => seen.push(f));
    off();
    t.send(PROMPT);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(0);
  });

  it("a malformed SSE line is skipped, not fatal (one bad frame must not kill the run)", async () => {
    const calls: string[] = [];
    const impl = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {not json\n\n`));
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ch: "acp", type: "ack", id: "r1", payload: {} })}\n\n`));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const t = createByocTransport({ baseUrl: "http://byoc:8080", sessionId: "sess-1", fetchImpl: impl });
    t.onFrame((f) => calls.push(f.type));
    t.send(PROMPT);
    await vi.waitFor(() => expect(calls).toEqual(["ack"]));
  });

  it("isOpen() is true before any failure — a fresh transport is usable", () => {
    const { impl } = sseFetch([]);
    const t = createByocTransport({ baseUrl: "http://byoc:8080", sessionId: "sess-1", fetchImpl: impl });
    expect(t.isOpen()).toBe(true);
  });
});
