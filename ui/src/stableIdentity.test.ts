/**
 * push() feeds these getters straight into useState, which bails out only on
 * Object.is. A getter that allocates on every call therefore re-renders the whole
 * thread on every notify — including during a stream, where notifies are frequent
 * and the values usually have not changed.
 */
import { describe, it, expect } from "vitest";

import { createIntegrityAgent } from "./integrityAgent.js";

const mk = () =>
  createIntegrityAgent({
    baseUrl: "http://h",
    conversationId: "c1",
    fetchImpl: (async () => new Response("", { status: 200 })) as never,
  });

describe("push() getters keep their identity when nothing changed", () => {
  it("getPendingInterrupts: an empty set is the SAME array each call", () => {
    const a = mk();
    expect(Object.is(a.getPendingInterrupts(), a.getPendingInterrupts())).toBe(true);
  });

  it("contextTokens: an unchanged reading is the SAME object each call", () => {
    const a = mk() as unknown as { contextUsedTokens: number; contextWindow: number; contextTokens: () => unknown };
    a.contextUsedTokens = 1000;
    a.contextWindow = 200000;
    expect(Object.is(a.contextTokens(), a.contextTokens())).toBe(true);
  });

  it("contextTokens: a CHANGED reading returns a new object (the update still lands)", () => {
    const a = mk() as unknown as { contextUsedTokens: number; contextWindow: number; contextTokens: () => unknown };
    a.contextUsedTokens = 1000;
    a.contextWindow = 200000;
    const first = a.contextTokens();
    a.contextUsedTokens = 2000;
    expect(Object.is(first, a.contextTokens())).toBe(false);
  });

  it("getQueuedMessages: already stable when idle (the pattern being matched)", () => {
    const a = mk();
    expect(Object.is(a.getQueuedMessages(), a.getQueuedMessages())).toBe(true);
  });
});
