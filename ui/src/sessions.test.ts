/**
 * Tier 1 (ui) — the ?thread=<id> deep-link selection.
 *
 * requestSelect must select a conversation even when it isn't in the list yet
 * (a webhook-created thread the user has never opened arrives via the server
 * poll/stream). It selects immediately when known, else waits (pendingSelect)
 * and mergeFromServer honors it the moment the target appears — the one
 * deliberate exception to mergeFromServer's selection-neutrality.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { sessionStore } from "./sessions.js";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
});

describe("deep-link selection (requestSelect)", () => {
  it("selects a conversation that is ALREADY in the list immediately", () => {
    sessionStore.mergeFromServer([{ id: "known-1" }, { id: "known-2" }]);
    sessionStore.requestSelect("known-2");
    expect(sessionStore.get().currentId).toBe("known-2");
  });

  it("selects a NOT-yet-known conversation once it arrives via the server", () => {
    // The deep-link target isn't in the list yet.
    sessionStore.requestSelect("from-slack");
    expect(sessionStore.get().currentId).not.toBe("from-slack");
    expect(sessionStore.get().pendingSelect).toBe("from-slack");

    // It arrives (poll/stream) — now it gets selected, and the pending clears.
    sessionStore.mergeFromServer([{ id: "from-slack", title: "Slack: help" }]);
    expect(sessionStore.get().currentId).toBe("from-slack");
    expect(sessionStore.get().pendingSelect).toBeUndefined();
  });

  it("a background merge does NOT hijack the selection (still selection-neutral)", () => {
    // Real server conversations carry a title (non-pristine), so they persist
    // across merges — the deep-link target isn't dropped as a phantom.
    sessionStore.mergeFromServer([{ id: "a", title: "Conv A" }]);
    sessionStore.requestSelect("a");
    expect(sessionStore.get().currentId).toBe("a");
    // A later merge bringing a newer conversation must NOT move the selection.
    sessionStore.mergeFromServer([
      { id: "a", title: "Conv A" },
      { id: "b", title: "Conv B", createdAt: Date.now() + 1000 },
    ]);
    expect(sessionStore.get().currentId).toBe("a");
  });
});
