/**
 * Tier 1 (ui) — the ?thread=<id> deep-link selection.
 *
 * requestSelect must select a conversation even when it isn't in the list yet
 * (a webhook-created thread the user has never opened arrives via the server
 * poll/stream). It selects immediately when known, else waits (pendingSelect)
 * and mergeFromServer honors it the moment the target appears — the one
 * deliberate exception to mergeFromServer's selection-neutrality.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  sessionStore,
  setConversationMinter,
  visibleSessions,
  nestSubagents,
  type Session,
} from "./sessions.js";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  // The store is a module singleton with no per-test reset. A rename lock left set by
  // a prior test (setEditing without a matching clearEditing) now FREEZES every later
  // test's mergeFromServer (the whole-sidebar freeze), so clear it between tests.
  sessionStore.clearEditing();
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

describe("merge reference stability (sidebar re-render / flake root)", () => {
  const byId = (id: string) => sessionStore.get().sessions.find((s) => s.id === id);

  it("reuses the SAME object reference for an unchanged conversation across merges", () => {
    sessionStore.mergeFromServer([{ id: "ref-a", title: "Alpha", createdAt: 1000 }]);
    const first = byId("ref-a");
    // A later poll returns the SAME conversation, unchanged.
    sessionStore.mergeFromServer([{ id: "ref-a", title: "Alpha", createdAt: 1000 }]);
    const second = byId("ref-a");
    // Same reference -> React.memo skips the row -> no re-render disrupts an
    // in-progress interaction (open rename / hover). This is the flake-family fix.
    expect(second).toBe(first);
  });

  it("produces a NEW reference only for the conversation that actually changed", () => {
    sessionStore.mergeFromServer([
      { id: "ch-x", title: "X", createdAt: 1 },
      { id: "ch-y", title: "Y", createdAt: 2 },
    ]);
    const x1 = byId("ch-x");
    const y1 = byId("ch-y");
    // Only Y's title changes on the next poll.
    sessionStore.mergeFromServer([
      { id: "ch-x", title: "X", createdAt: 1 },
      { id: "ch-y", title: "Y renamed", createdAt: 2 },
    ]);
    expect(byId("ch-x")).toBe(x1); // unchanged -> same ref
    expect(byId("ch-y")).not.toBe(y1); // changed -> new ref
    expect(byId("ch-y")?.title).toBe("Y renamed");
  });
});

describe("editing lock (rename in progress freezes the sidebar — the CI rename flake)", () => {
  const byId = (id: string) => sessionStore.get().sessions.find((s) => s.id === id);

  it("a merge does NOT mutate the row being renamed (title/userTitled held)", () => {
    sessionStore.mergeFromServer([{ id: "edit-a", title: "Original", createdAt: 1 }]);
    sessionStore.setEditing("edit-a");
    // The agent's <title> update lands on the poll mid-rename — it must be ignored
    // for the editing row (which is exactly what re-rendered the open input away).
    sessionStore.mergeFromServer([{ id: "edit-a", title: "Agent-picked title", createdAt: 1 }]);
    expect(byId("edit-a")?.title).toBe("Original");
    expect(byId("edit-a")?.userTitled).toBeFalsy();
  });

  it("keeps the SAME object reference for the editing row across a merge (React.memo skips it)", () => {
    sessionStore.mergeFromServer([{ id: "edit-ref", title: "Alpha", createdAt: 2 }]);
    sessionStore.setEditing("edit-ref");
    const before = byId("edit-ref");
    // A merge that WOULD otherwise change the title (new object) must not touch it.
    sessionStore.mergeFromServer([{ id: "edit-ref", title: "Changed by agent", createdAt: 2 }]);
    expect(byId("edit-ref")).toBe(before);
  });

  it("freezes the WHOLE sidebar while renaming (a merge is a full no-op, not just per-row)", () => {
    sessionStore.mergeFromServer([
      { id: "lock-a", title: "A", createdAt: 1 },
      { id: "lock-b", title: "B", createdAt: 2 },
    ]);
    sessionStore.setEditing("lock-a");
    // A background merge that changes BOTH the editing row AND another row must be
    // dropped entirely — per-row locking wasn't enough: the merge still re-rendered
    // <Sidebar> and that reconciliation detached the open input / swallowed the
    // open-click (the CI flake, mode "input never appears"). So while any rename is
    // open, mergeFromServer no-ops for every row; the next poll after clearEditing
    // reconciles server-truth.
    sessionStore.mergeFromServer([
      { id: "lock-a", title: "A changed", createdAt: 1 },
      { id: "lock-b", title: "B changed", createdAt: 2 },
    ]);
    expect(byId("lock-a")?.title).toBe("A"); // editing row held
    expect(byId("lock-b")?.title).toBe("B"); // other rows ALSO held (whole-sidebar freeze)
  });

  it("applies server-truth again once the rename clears", () => {
    sessionStore.mergeFromServer([{ id: "edit-clear", title: "Original", createdAt: 3 }]);
    sessionStore.setEditing("edit-clear");
    sessionStore.mergeFromServer([{ id: "edit-clear", title: "Agent title", createdAt: 3 }]);
    expect(byId("edit-clear")?.title).toBe("Original"); // held while editing
    // Rename committed/cancelled -> lock clears -> the next merge applies again.
    sessionStore.clearEditing("edit-clear");
    sessionStore.mergeFromServer([{ id: "edit-clear", title: "Agent title", createdAt: 3 }]);
    expect(byId("edit-clear")?.title).toBe("Agent title");
  });

  it("clearEditing(id) is a no-op when a DIFFERENT row is being edited", () => {
    sessionStore.mergeFromServer([{ id: "ce-a", title: "A", createdAt: 1 }]);
    sessionStore.setEditing("ce-a");
    sessionStore.clearEditing("ce-b"); // stale clear from another row
    expect(sessionStore.get().editingId).toBe("ce-a");
    sessionStore.clearEditing("ce-a");
    expect(sessionStore.get().editingId).toBeUndefined();
  });

  it("a user rename made during editing survives the merge that arrives before clear", () => {
    sessionStore.mergeFromServer([{ id: "edit-user", title: "Original", createdAt: 4 }]);
    sessionStore.setEditing("edit-user");
    sessionStore.renameSession("edit-user", "My pinned project"); // optimistic + lock
    // A poll still reporting the agent's guess arrives before the input closes.
    sessionStore.mergeFromServer([{ id: "edit-user", title: "Agent guess", createdAt: 4 }]);
    expect(byId("edit-user")?.title).toBe("My pinned project");
    expect(byId("edit-user")?.userTitled).toBe(true);
  });
});

describe("per-conversation model (model-switch scoping)", () => {
  it("setModel changes ONLY the target conversation, never the others", () => {
    sessionStore.mergeFromServer([{ id: "a" }, { id: "b" }, { id: "c" }]);
    sessionStore.setModel("a", "claude-sonnet-4-6");

    const byId = Object.fromEntries(sessionStore.get().sessions.map((s) => [s.id, s.model]));
    expect(byId.a).toBe("claude-sonnet-4-6");
    expect(byId.b).toBeUndefined(); // NOT leaked
    expect(byId.c).toBeUndefined(); // NOT leaked
  });

  it("a background list-refresh does NOT propagate one conversation's model to the rest", () => {
    // The reported "one switch, four others followed" shape: switch A, then a poll
    // (mergeFromServer) arrives. B/C must keep their own (unset) model.
    sessionStore.mergeFromServer([{ id: "a" }, { id: "b" }, { id: "c" }]);
    sessionStore.setModel("a", "claude-sonnet-4-6");

    // Poll returns the server's view: A persisted its pick; B/C never set one.
    sessionStore.mergeFromServer([
      { id: "a", model: "claude-sonnet-4-6" },
      { id: "b" },
      { id: "c" },
    ]);

    const byId = Object.fromEntries(sessionStore.get().sessions.map((s) => [s.id, s.model]));
    expect(byId.a).toBe("claude-sonnet-4-6");
    expect(byId.b).toBeUndefined();
    expect(byId.c).toBeUndefined();
  });

  it("a locally-chosen model survives a poll that hasn't persisted it yet (first send pending)", () => {
    // The merge prefers the LOCAL pick (existing?.model ?? c.model): a switch made
    // before the first prompt persists it server-side must not be clobbered by a
    // poll that still reports the conversation with no model.
    sessionStore.mergeFromServer([{ id: "a" }]);
    sessionStore.setModel("a", "claude-haiku-4-5");
    sessionStore.mergeFromServer([{ id: "a" /* server hasn't stored the model yet */ }]);
    expect(sessionStore.get().sessions.find((s) => s.id === "a")?.model).toBe("claude-haiku-4-5");
  });

  it("switching conversations does not carry a model between them (switchTo is model-neutral)", () => {
    sessionStore.mergeFromServer([{ id: "a" }, { id: "b" }]);
    sessionStore.setModel("a", "claude-sonnet-4-6");
    sessionStore.switchTo("b");
    // B's determined model is still its own (unset) — not A's pick.
    expect(sessionStore.get().sessions.find((s) => s.id === "b")?.model).toBeUndefined();
    expect(sessionStore.get().currentId).toBe("b");
  });
});

describe("favoriting pins a conversation to the top of the list", () => {
  // The store is a module singleton with no per-test reset, so use UNIQUE ids to
  // avoid cross-test accumulation (the existing tests follow the same convention).
  // `only` restricts the visible list to just these ids for a clean assertion.
  const only = (...ids: string[]) => sessionStore.get().sessions.filter((s) => ids.includes(s.id)).map((s) => s.id);

  it("starred conversations sort ABOVE unstarred ones (then newest-first within each group)", () => {
    sessionStore.mergeFromServer([
      { id: "star-old", title: "Old", createdAt: 1_000 },
      { id: "star-mid", title: "Mid", createdAt: 2_000 },
      { id: "star-new", title: "New", createdAt: 3_000 },
    ]);
    expect(only("star-new", "star-mid", "star-old")).toEqual(["star-new", "star-mid", "star-old"]);

    // Star the OLDEST — it jumps to the top despite being least recent.
    sessionStore.setStarred("star-old", true);
    expect(only("star-new", "star-mid", "star-old")).toEqual(["star-old", "star-new", "star-mid"]);
  });

  it("re-sorts immediately on toggle (no wait for a server merge)", () => {
    sessionStore.mergeFromServer([
      { id: "imm-a", title: "A", createdAt: 3_000 },
      { id: "imm-b", title: "B", createdAt: 2_000 },
      { id: "imm-c", title: "C", createdAt: 1_000 },
    ]);
    sessionStore.setStarred("imm-c", true);
    sessionStore.setStarred("imm-b", true);
    // Both starred -> above 'imm-a'; newest-first among starred (b @2000 before c @1000).
    expect(only("imm-a", "imm-b", "imm-c")).toEqual(["imm-b", "imm-c", "imm-a"]);
  });

  it("un-starring drops a conversation back into recency order", () => {
    sessionStore.mergeFromServer([
      { id: "un-a", title: "A", createdAt: 3_000, starred: true },
      { id: "un-b", title: "B", createdAt: 2_000 },
      { id: "un-c", title: "C", createdAt: 1_000 },
    ]);
    expect(only("un-a", "un-b", "un-c")).toEqual(["un-a", "un-b", "un-c"]);
    sessionStore.setStarred("un-a", false);
    expect(only("un-a", "un-b", "un-c")).toEqual(["un-a", "un-b", "un-c"]); // a @3000 is still newest
  });

  it("a server merge that only flips a star re-orders (not skipped by the no-op guard)", () => {
    sessionStore.mergeFromServer([
      { id: "poll-a", title: "A", createdAt: 3_000 },
      { id: "poll-b", title: "B", createdAt: 1_000 },
    ]);
    expect(only("poll-a", "poll-b")).toEqual(["poll-a", "poll-b"]);
    // Next poll: the server reports b as starred (persisted / starred elsewhere).
    sessionStore.mergeFromServer([
      { id: "poll-a", title: "A", createdAt: 3_000 },
      { id: "poll-b", title: "B", createdAt: 1_000, starred: true },
    ]);
    expect(only("poll-a", "poll-b")).toEqual(["poll-b", "poll-a"]);
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
  it("does NOT drop the currently-selected 'New chat' the server hasn't seen yet", async () => {
    // A real server conversation already exists (so the merge has 'truth' to
    // reconcile against — the condition that used to trigger the phantom-drop).
    sessionStore.mergeFromServer([{ id: "server-conv", title: "Existing" }]);

    // The user clicks "New chat": a pristine, server-unknown, SELECTED session. The id
    // stays local until the first send, so the merge will not know about it — which is
    // exactly the case this guards.
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

describe("user rename + starring", () => {
  const titleOf = (id: string) => sessionStore.get().sessions.find((s) => s.id === id)?.title;
  const of = (id: string) => sessionStore.get().sessions.find((s) => s.id === id);

  it("renameSession sets the title and LOCKS it (userTitled) against the agent", () => {
    sessionStore.mergeFromServer([{ id: "c", title: "Agent guess" }]);
    sessionStore.renameSession("c", "My name");
    expect(titleOf("c")).toBe("My name");
    expect(of("c")?.userTitled).toBe(true);

    // The agent tries to set a new title — locked, so it's ignored.
    sessionStore.setTitle("c", "Agent's new guess");
    expect(titleOf("c")).toBe("My name");
  });

  it("a server userTitled merge wins over a stale local title immediately", () => {
    // Local thinks the title is the agent's; the server reports a user rename.
    sessionStore.mergeFromServer([{ id: "c", title: "Agent guess" }]);
    sessionStore.mergeFromServer([{ id: "c", title: "Pinned by user", userTitled: true }]);
    expect(titleOf("c")).toBe("Pinned by user");
    expect(of("c")?.userTitled).toBe(true);
  });

  it("setStarred toggles the flag, and a server merge carries it", () => {
    sessionStore.mergeFromServer([{ id: "c", title: "X" }]);
    expect(of("c")?.starred).toBeFalsy();
    sessionStore.setStarred("c", true);
    expect(of("c")?.starred).toBe(true);
    // Server confirms it on the next merge.
    sessionStore.mergeFromServer([{ id: "c", title: "X", starred: true }]);
    expect(of("c")?.starred).toBe(true);
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

describe("the SERVER owns conversation ids", () => {
  it("newSession() selects the new conversation SYNCHRONOUSLY (no server round-trip)", () => {
    // Asking the server for the id here would leave the UI on the PREVIOUS conversation
    // for the length of a network call, so a fast typist sends into the wrong thread.
    const mint = vi.fn(async () => "must-not-be-called-yet");
    setConversationMinter(mint);

    const id = sessionStore.newSession();

    expect(mint).not.toHaveBeenCalled();
    expect(sessionStore.get().currentId).toBe(id);
    expect(sessionStore.current().serverCreated).toBe(false);
  });

  it("the local id is replaced by the server's on the FIRST SEND", async () => {
    sessionStore.newSession();
    const local = sessionStore.get().currentId;
    setConversationMinter(async () => "server-assigned-id");

    const id = await sessionStore.ensureCurrentCreated();

    expect(id).toBe("server-assigned-id");
    expect(sessionStore.get().currentId).toBe("server-assigned-id");
    expect(sessionStore.get().sessions.some((s) => s.id === local)).toBe(false);
  });

  it("a failed create leaves the store UNTOUCHED", async () => {
    sessionStore.newSession();
    const before = sessionStore.get();

    setConversationMinter(async () => null);
    const id = await sessionStore.ensureCurrentCreated();

    expect(id).toBeNull();
    expect(sessionStore.get().currentId).toBe(before.currentId);
    expect(sessionStore.get().sessions).toHaveLength(before.sessions.length);
  });

  it("ensureCurrentCreated() replaces a locally-seeded id with the server's", async () => {
    // freshState() seeds a conversation at module load so the UI has something to render
    // before any network call, and deleteSession() seeds a replacement the same way. Those
    // ids are client-chosen and /agui refuses them. Reproduce that state directly: the
    // store is a module singleton, so an earlier test may have left a created one current.
    // Delete every session: the last deletion seeds a fresh client-chosen replacement,
    // which is exactly the state freshState() leaves the app in on first load.
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    const seeded = sessionStore.get().currentId;
    expect(sessionStore.current().serverCreated).toBeFalsy();

    setConversationMinter(async () => "real-id");
    const id = await sessionStore.ensureCurrentCreated();

    expect(id).toBe("real-id");
    expect(sessionStore.get().currentId).toBe("real-id");
    expect(sessionStore.get().sessions.some((s) => s.id === seeded)).toBe(false);
  });

  it("ensureCurrentCreated() is a NO-OP for an already-created conversation", async () => {
    setConversationMinter(async () => "made-once");
    sessionStore.newSession();
    await sessionStore.ensureCurrentCreated();

    const mint = vi.fn(async () => "must-not-be-used");
    setConversationMinter(mint);
    const id = await sessionStore.ensureCurrentCreated();

    expect(mint).not.toHaveBeenCalled();
    expect(id).toBe("made-once");
  });

  it("CONCURRENT ensureCurrentCreated() calls share ONE create", async () => {
    // Every mount asks — a page load, a conversation switch, React StrictMode's double
    // effect. Without de-duping, each overlapping call POSTs /conversations and leaves a
    // stray empty conversation in the sidebar (5 rows where the test expected 2).
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    let calls = 0;
    setConversationMinter(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return `server-${calls}`;
    });

    const [a, b, c] = await Promise.all([
      sessionStore.ensureCurrentCreated(),
      sessionStore.ensureCurrentCreated(),
      sessionStore.ensureCurrentCreated(),
    ]);

    expect(calls).toBe(1);
    expect(a).toBe("server-1");
    expect(b).toBe("server-1");
    expect(c).toBe("server-1");
    expect(sessionStore.get().sessions).toHaveLength(1);
  });

  it("a server-listed conversation is never re-created", async () => {
    sessionStore.mergeFromServer([{ id: "from-server", title: "Existing" }]);
    sessionStore.switchTo("from-server");

    const mint = vi.fn(async () => "must-not-be-used");
    setConversationMinter(mint);
    const id = await sessionStore.ensureCurrentCreated();

    expect(mint).not.toHaveBeenCalled();
    expect(id).toBe("from-server");
  });
});
