/**
 * session/update variants the pinned ACP SDK can't parse.
 *
 * Goose emits `session_info_update` / `usage_update`; the SDK
 * (@zed-industries/agent-client-protocol 0.4.5, the package's FINAL release —
 * it was renamed, so there is no newer version to bump to) validates the whole
 * notification against a closed zod union first. An unknown variant fails that
 * parse, the SDK rejects the notification with -32602 and console.errors it, and
 * `normalizeUpdate`'s `default:` branch never gets a say. These specs pin the
 * premise, the fix, and the salvage.
 */

import { describe, expect, it, vi } from "vitest";

import {
  ClientSideConnection,
  ndJsonStream,
  sessionNotificationSchema,
  type Client,
  type Stream,
} from "@zed-industries/agent-client-protocol";

import {
  SDK_SESSION_UPDATE_VARIANTS,
  contextUsageFromUsageUpdate,
  filterUnsupportedSessionUpdates,
  unsupportedSessionUpdate,
} from "../../src/acp/sessionUpdateFilter.js";

const notification = (update: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  method: "session/update",
  params: { sessionId: "s1", update },
});

describe("the premise: the pinned SDK rejects unknown session/update variants", () => {
  it("throws on usage_update and session_info_update, accepts a known variant", () => {
    // If this ever STOPS throwing the SDK has learned these variants and the
    // filter's variant set should be widened rather than left to drop them.
    expect(() =>
      sessionNotificationSchema.parse(notification({ sessionUpdate: "usage_update", used: 1, size: 2 }).params),
    ).toThrow();
    expect(() =>
      sessionNotificationSchema.parse(notification({ sessionUpdate: "session_info_update" }).params),
    ).toThrow();
    expect(() =>
      sessionNotificationSchema.parse(
        notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }).params,
      ),
    ).not.toThrow();
  });

  it("SDK_SESSION_UPDATE_VARIANTS is exactly what the SDK accepts", () => {
    // Guards the hand-maintained set against drifting from the SDK on upgrade in
    // BOTH directions: a variant listed here that the SDK rejects resumes the
    // -32602 spam, and one the SDK gained that isn't listed gets silently dropped.
    // Each fixture is the minimal payload that union member requires.
    const chunk = { content: { type: "text", text: "x" } };
    const minimal: Record<string, Record<string, unknown>> = {
      user_message_chunk: chunk,
      agent_message_chunk: chunk,
      agent_thought_chunk: chunk,
      tool_call: { title: "t", toolCallId: "c" },
      tool_call_update: { toolCallId: "c" },
      plan: { entries: [] },
      available_commands_update: { availableCommands: [] },
      current_mode_update: { currentModeId: "m" },
    };

    expect(new Set(Object.keys(minimal))).toEqual(new Set(SDK_SESSION_UPDATE_VARIANTS));
    for (const [variant, fields] of Object.entries(minimal)) {
      expect(() =>
        sessionNotificationSchema.parse(notification({ ...fields, sessionUpdate: variant }).params),
      ).not.toThrow();
    }
  });
});

describe("unsupportedSessionUpdate", () => {
  it("flags an unknown variant and passes known ones through", () => {
    expect(unsupportedSessionUpdate(notification({ sessionUpdate: "usage_update" }))?.variant).toBe(
      "usage_update",
    );
    expect(unsupportedSessionUpdate(notification({ sessionUpdate: "tool_call" }))).toBeUndefined();
  });

  it("never swallows a message with an id", () => {
    // A request expects a response; dropping one would HANG the agent rather
    // than lose an update — strictly worse than the -32602 this fixes.
    const request = { ...notification({ sessionUpdate: "usage_update" }), id: 7 };
    expect(unsupportedSessionUpdate(request)).toBeUndefined();
  });

  it("ignores messages that aren't session/update notifications", () => {
    expect(unsupportedSessionUpdate({ jsonrpc: "2.0", method: "session/cancel" })).toBeUndefined();
    expect(unsupportedSessionUpdate(notification({}))).toBeUndefined();
    expect(unsupportedSessionUpdate(null)).toBeUndefined();
  });
});

describe("contextUsageFromUsageUpdate", () => {
  const dropped = (update: Record<string, unknown>) => ({
    sessionId: "s1",
    variant: String(update.sessionUpdate ?? ""),
    update,
  });

  it("maps the spec's used/size onto our context_usage numbers", () => {
    expect(contextUsageFromUsageUpdate(dropped({ sessionUpdate: "usage_update", used: 1200, size: 200_000 }))).toEqual(
      { usedTokens: 1200, contextWindow: 200_000 },
    );
  });

  it("returns undefined rather than a wrong context bar when the shape differs", () => {
    // An agent that disagrees with the spec must yield NO reading, not a bogus one.
    expect(contextUsageFromUsageUpdate(dropped({ sessionUpdate: "usage_update", used: 1 }))).toBeUndefined();
    expect(
      contextUsageFromUsageUpdate(dropped({ sessionUpdate: "usage_update", used: 1, size: 0 })),
    ).toBeUndefined();
    expect(
      contextUsageFromUsageUpdate(dropped({ sessionUpdate: "usage_update", used: "1", size: "2" })),
    ).toBeUndefined();
    expect(contextUsageFromUsageUpdate(dropped({ sessionUpdate: "session_info_update" }))).toBeUndefined();
  });
});

describe("filterUnsupportedSessionUpdates", () => {
  /** An in-memory ACP stream pair plus a handle to push agent->client lines. */
  const wireUp = () => {
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
  };

  const fakeClient = (onUpdate: (variant: string) => void): Client =>
    ({
      sessionUpdate: async (params: { update: { sessionUpdate: string } }) => {
        onUpdate(params.update.sessionUpdate);
      },
    }) as unknown as Client;

  it("stops the SDK -32602-ing an unknown variant, and keeps known ones in order", async () => {
    const { raw, send, close } = wireUp();
    const seen: string[] = [];
    const dropped: string[] = [];
    const stream = filterUnsupportedSessionUpdates(raw, (d) => dropped.push(d.variant));
    // The SDK console.errors "Error handling notification" for every rejected
    // notification — that log line IS the reported error volume.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      new ClientSideConnection(() => fakeClient((v) => seen.push(v)), stream);

      await send(notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }));
      await send(notification({ sessionUpdate: "usage_update", used: 5, size: 10 }));
      await send(notification({ sessionUpdate: "session_info_update", title: "t" }));
      await send(notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } }));
      await close();
      await vi.waitFor(() => expect(seen.length).toBe(2));

      expect(seen).toEqual(["agent_message_chunk", "agent_message_chunk"]);
      expect(dropped).toEqual(["usage_update", "session_info_update"]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("without the filter the same stream produces the SDK error (guards the premise)", async () => {
    const { raw, send, close } = wireUp();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      new ClientSideConnection(() => fakeClient(() => {}), raw);
      await send(notification({ sessionUpdate: "usage_update", used: 5, size: 10 }));
      await close();
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect(consoleError.mock.calls[0][0]).toContain("Error handling notification");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a throwing onDropped cannot tear down the connection", async () => {
    const { raw, send, close } = wireUp();
    const seen: string[] = [];
    const stream = filterUnsupportedSessionUpdates(raw, () => {
      throw new Error("boom");
    });
    new ClientSideConnection(() => fakeClient((v) => seen.push(v)), stream);

    await send(notification({ sessionUpdate: "usage_update" }));
    await send(notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }));
    await close();
    await vi.waitFor(() => expect(seen).toEqual(["agent_message_chunk"]));
  });
});
