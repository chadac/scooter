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

import { sessionStore, visibleSessions, nestSubagents, type Session } from "./sessions.js";

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

describe("ended subagents are pruned from the sidebar", () => {
  it("drops a subagent the server no longer lists (it ended), keeping the parent", () => {
    // Parent + subagent both known.
    sessionStore.mergeFromServer([
      { id: "parent-1", title: "Parent" },
      { id: "sub-1", title: "echo test", parentId: "parent-1" },
    ]);
    expect(sessionStore.get().sessions.some((s) => s.id === "sub-1")).toBe(true);

    // Next poll: the subagent finished + was end()ed server-side, so it's absent.
    sessionStore.mergeFromServer([{ id: "parent-1", title: "Parent" }]);
    const ids = sessionStore.get().sessions.map((s) => s.id);
    expect(ids).toContain("parent-1"); // parent stays
    expect(ids).not.toContain("sub-1"); // ended subagent pruned
  });

  it("does NOT prune a top-level conversation missing from a single merge", () => {
    // A local top-level conv with a real title must survive (only subagents prune
    // on absence — a top-level one may just be filtered out of this scope).
    sessionStore.mergeFromServer([{ id: "top-1", title: "Real chat" }]);
    sessionStore.mergeFromServer([{ id: "other", title: "Other" }]);
    expect(sessionStore.get().sessions.some((s) => s.id === "top-1")).toBe(true);
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

describe("visibleSessions (Mine/All owner filter)", () => {
  const seed = () =>
    sessionStore.mergeFromServer([
      { id: "a1", title: "Alice", owner: "alice" },
      { id: "b1", title: "Bob", owner: "bob" },
      { id: "u1", title: "Unowned", owner: undefined },
    ]);
  const titles = () =>
    visibleSessions(sessionStore.get())
      .map((s) => s.title)
      .filter((t): t is string => !!t)
      .sort();

  it("ANONYMOUS caller sees everything under Mine (id is the truthy string 'anonymous' — guard on the flag)", () => {
    seed();
    sessionStore.setCurrentUser({ id: "anonymous", anonymous: true });
    sessionStore.setScope("mine");
    // Regression guard: 'anonymous' is truthy, so a `!currentUser` check would
    // wrongly engage the strict filter and hide every unowned conversation. All
    // three seeded convs (incl. the unowned one) must remain visible.
    const t = titles();
    expect(t).toContain("Alice");
    expect(t).toContain("Bob");
    expect(t).toContain("Unowned");
  });

  it("a KNOWN user under Mine sees STRICTLY their own (not others, not unowned)", () => {
    seed();
    sessionStore.setCurrentUser({ id: "alice", email: "alice@x.io", anonymous: false });
    sessionStore.setScope("mine");
    // Only alice's own — bob's + every unowned conv (incl. the default "New chat")
    // are hidden.
    expect(titles()).toEqual(["Alice"]);
  });

  it("a KNOWN user under All sees everything", () => {
    seed();
    sessionStore.setCurrentUser({ id: "alice", anonymous: false });
    sessionStore.setScope("all");
    const t = titles();
    expect(t).toContain("Alice");
    expect(t).toContain("Bob");
    expect(t).toContain("Unowned");
  });
});

describe("nestSubagents (sidebar hierarchy)", () => {
  const s = (id: string, parentId?: string): Session => ({ id, title: id, createdAt: 1, parentId });

  it("with no activeId, expands every parent's children", () => {
    // Flat input (arbitrary order); children of p1 + p2 interleaved.
    const flat = [s("p1"), s("p2"), s("c1a", "p1"), s("c2a", "p2"), s("c1b", "p1")];
    const rows = nestSubagents(flat);
    expect(rows.map((r) => r.session.id)).toEqual(["p1", "c1a", "c1b", "p2", "c2a"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0, 1]);
  });

  it("AUTO-COLLAPSES a parent's children when neither the parent nor a child is active", () => {
    const flat = [s("p1"), s("c1a", "p1"), s("c1b", "p1"), s("p2"), s("c2a", "p2")];
    // p2 is active -> p2's children expand; p1 is off the active branch -> collapsed.
    const rows = nestSubagents(flat, "p2");
    expect(rows.map((r) => r.session.id)).toEqual(["p1", "p2", "c2a"]);
    // The COLLAPSED parent (p1) carries its child count so the UI can show "▸ 2".
    expect(rows.find((r) => r.session.id === "p1")?.childCount).toBe(2);
    // p2 is active + expanded, so its children are visible (childCount 0).
    expect(rows.find((r) => r.session.id === "p2")?.childCount).toBe(0);
  });

  it("expands a parent's children when a CHILD is the active conversation", () => {
    const flat = [s("p1"), s("c1a", "p1"), s("c1b", "p1"), s("p2"), s("c2a", "p2")];
    // c1a (a child of p1) is active -> p1's branch expands, p2 collapses.
    const rows = nestSubagents(flat, "c1a");
    expect(rows.map((r) => r.session.id)).toEqual(["p1", "c1a", "c1b", "p2"]);
  });

  it("a child whose parent is NOT in the list renders as a top-level row", () => {
    // The parent was filtered out (e.g. Mine hid it) — the orphaned child still shows.
    const rows = nestSubagents([s("orphan", "missing-parent")]);
    expect(rows.map((r) => r.session.id)).toEqual(["orphan"]);
    expect(rows[0].depth).toBe(0);
  });

  it("top-level-only list is unchanged (all depth 0)", () => {
    const rows = nestSubagents([s("a"), s("b")]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });
});
