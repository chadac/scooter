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

describe("a brand-new conversation survives the background merge", () => {
  it("does NOT drop the currently-selected 'New chat' the server hasn't seen yet", () => {
    // A real server conversation already exists (so the merge has 'truth' to
    // reconcile against — the condition that used to trigger the phantom-drop).
    sessionStore.mergeFromServer([{ id: "server-conv", title: "Existing" }]);

    // The user clicks "New chat": a pristine, server-unknown, SELECTED session.
    // The server won't learn about it until the first message POSTs /agui.
    const fresh = sessionStore.newSession();
    expect(sessionStore.get().currentId).toBe(fresh);

    // The 10s poll fires: the server list still doesn't include the new chat.
    // The fresh conversation (pristine + unknown to the server) must NOT be
    // dropped, and the selection must NOT jump to the existing conversation.
    sessionStore.mergeFromServer([{ id: "server-conv", title: "Existing" }]);

    expect(sessionStore.get().sessions.some((s) => s.id === fresh)).toBe(true);
    expect(sessionStore.get().currentId).toBe(fresh);
  });

  it("still drops a pristine placeholder the user has LEFT (not selected)", () => {
    // Two conversations: a real one and a pristine placeholder. Select the real
    // one, so the pristine placeholder is NOT current — it's a genuine phantom.
    const pristine = sessionStore.get().currentId; // the initial fresh "New chat"
    sessionStore.mergeFromServer([{ id: "real", title: "Real" }]);
    sessionStore.switchTo("real");
    expect(sessionStore.get().currentId).toBe("real");

    // A later merge (server still doesn't know the untouched placeholder) drops it.
    sessionStore.mergeFromServer([{ id: "real", title: "Real" }]);
    expect(sessionStore.get().sessions.some((s) => s.id === pristine)).toBe(false);
  });
});
