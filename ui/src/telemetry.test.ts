/**
 * Telemetry must be INERT and SAFE when it is off, which is the default everywhere.
 *
 * The rule under test: no call in this module may throw into its caller, and none may do
 * anything observable before a collector is configured. Telemetry that can break the app
 * it observes is worse than no telemetry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { record, startSpan, recordError, initTelemetryFromServer, ATTR } from "./telemetry.js";

describe("telemetry is inert when disabled", () => {
  it("record() does nothing and does not throw", () => {
    expect(() => record("some.event", { a: "b" })).not.toThrow();
  });

  it("startSpan() returns undefined rather than a fake span", () => {
    // Callers use `?.end()`; handing back a stub would hide a misconfiguration.
    expect(startSpan("some.span")).toBeUndefined();
  });

  it("recordError() swallows anything, including non-Errors", () => {
    expect(() => recordError("boom", new Error("real"))).not.toThrow();
    expect(() => recordError("boom", "a string")).not.toThrow();
    expect(() => recordError("boom", undefined)).not.toThrow();
    expect(() => recordError("boom", { weird: true })).not.toThrow();
  });
});

describe("initTelemetryFromServer", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("stays OFF when the config endpoint 404s (no collector deployed)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as never;
    await expect(initTelemetryFromServer()).resolves.toBeUndefined();
    expect(startSpan("x")).toBeUndefined();
  });

  it("stays OFF when the config says enabled:false", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }),
    ) as never;
    await initTelemetryFromServer();
    expect(startSpan("x")).toBeUndefined();
  });

  it("does not throw when the config is malformed", async () => {
    globalThis.fetch = vi.fn(async () => new Response("not json", { status: 200 })) as never;
    await expect(initTelemetryFromServer()).resolves.toBeUndefined();
  });

  it("does not throw when the fetch itself rejects (offline / blocked)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as never;
    await expect(initTelemetryFromServer()).resolves.toBeUndefined();
  });
});

describe("attribute names are stable", () => {
  it("keeps BOTH conversation identifiers", () => {
    // A conversation has a local key before the server assigns its id, so the window where
    // bugs live spans both. Dropping either breaks the trace exactly there.
    expect(ATTR.conversationKey).toBe("scooter.conversation.key");
    expect(ATTR.conversationId).toBe("scooter.conversation.id");
  });
});
