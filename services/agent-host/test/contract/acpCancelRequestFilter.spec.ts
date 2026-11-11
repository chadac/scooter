/** Goose's `$/cancel_request` must not reach the SDK. */

import { describe, expect, it, vi } from "vitest";

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type Stream,
} from "@zed-industries/agent-client-protocol";

import { filterCancelRequests, isCancelRequest } from "../../src/acp/cancelRequestFilter.js";

const cancel = (requestId: unknown) => ({
  jsonrpc: "2.0" as const,
  method: "$/cancel_request",
  params: { requestId },
});

const chunk = (text: string) => ({
  jsonrpc: "2.0" as const,
  method: "session/update",
  params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
});

/** An in-memory ACP stream with an agent-side sender. */
function wireUp() {
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const raw: Stream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
  const writer = agentToClient.writable.getWriter();
  const encoder = new TextEncoder();
  return {
    raw,
    send: (msg: unknown) => writer.write(encoder.encode(`${JSON.stringify(msg)}\n`)),
    close: () => writer.close(),
  };
}

const textClient = (seen: string[]): Client =>
  ({
    sessionUpdate: async (p: { update: { content: { text: string } } }) => {
      seen.push(p.update.content.text);
    },
  }) as unknown as Client;

describe("isCancelRequest", () => {
  it("matches only id-less $/cancel_request notifications", () => {
    expect(isCancelRequest(cancel(7))).toBe(true);
    expect(isCancelRequest({ jsonrpc: "2.0", method: "$/cancel_request" })).toBe(true);
    expect(isCancelRequest({ ...cancel(7), id: 1 })).toBe(false);
    expect(isCancelRequest(chunk("a"))).toBe(false);
    expect(isCancelRequest(null)).toBe(false);
  });
});

describe("filterCancelRequests", () => {
  it("without the filter the SDK console.errors (guards the premise)", async () => {
    const { raw, send, close } = wireUp();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      new ClientSideConnection(() => textClient([]), raw);
      await send(cancel(3));
      await close();
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect(consoleError.mock.calls[0]![0]).toBe("Error handling notification");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("drops $/cancel_request silently and keeps other messages in order", async () => {
    const { raw, send, close } = wireUp();
    const seen: string[] = [];
    const cancelled: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      new ClientSideConnection(() => textClient(seen), filterCancelRequests(raw, (id) => cancelled.push(id)));
      await send(chunk("a"));
      await send(cancel(3));
      await send(chunk("b"));
      await close();
      await vi.waitFor(() => expect(seen).toEqual(["a", "b"]));
      expect(cancelled).toEqual([3]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a throwing onCancel cannot tear down the connection", async () => {
    const { raw, send, close } = wireUp();
    const seen: string[] = [];
    const stream = filterCancelRequests(raw, () => {
      throw new Error("boom");
    });
    new ClientSideConnection(() => textClient(seen), stream);
    await send(cancel(3));
    await send(chunk("a"));
    await close();
    await vi.waitFor(() => expect(seen).toEqual(["a"]));
  });
});
