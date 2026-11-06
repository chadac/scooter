/**
 * Session store unit tests: deep-link selection, merge reference stability, link-source
 * ownership, the rename lock, per-conversation models, starring, subagent pruning and
 * nesting, and the rule that only the server issues conversation ids.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  conversationFor,
  sessionStore,
  setConversationMinter,
  visibleSessions,
  nestSubagents,
  type Session,
  type SidebarRow,
} from "./sessions.js";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  // The store is a module singleton, so a leaked rename lock would freeze every later test's mergeFromServer.
  sessionStore.clearEditing();
  sessionStore.clearHover();
  // A leaked query would decide whether a rename lock is still honored.
  sessionStore.setQuery("");
});

describe("deep-link selection (requestSelect)", () => {
  it("selects a conversation that is ALREADY in the list immediately", () => {
    sessionStore.mergeFromServer([{ id: "known-1" }, { id: "known-2" }]);
    sessionStore.requestSelect("known-2");
    expect(sessionStore.get().currentId).toBe("known-2");
  });

  it("selects a NOT-yet-known conversation once it arrives via the server", () => {
    // The deep-link target is not in the list yet.
    sessionStore.requestSelect("from-slack");
    expect(sessionStore.get().currentId).not.toBe("from-slack");
    expect(sessionStore.get().pendingSelect).toBe("from-slack");

    // Once it arrives it is selected and the pending clears.
    sessionStore.mergeFromServer([{ id: "from-slack", title: "Slack: help" }]);
    expect(sessionStore.get().currentId).toBe("from-slack");
    expect(sessionStore.get().pendingSelect).toBeUndefined();
  });

  it("a background merge does NOT hijack the selection (still selection-neutral)", () => {
    sessionStore.mergeFromServer([{ id: "a", title: "Conv A" }]);
    sessionStore.requestSelect("a");
    expect(sessionStore.get().currentId).toBe("a");
    // A later merge bringing a newer conversation must not move the selection.
    const now = Date.now();
    sessionStore.mergeFromServer([
      { id: "a", title: "Conv A" },
      { id: "b", title: "Conv B", createdAt: now + 1000, lastActivityAt: now + 1000 },
    ]);
    expect(sessionStore.get().currentId).toBe("a");
  });
});

describe("merge reference stability (sidebar re-render / flake root)", () => {
  const byId = (id: string) => sessionStore.get().sessions.find((s) => s.id === id);

  it("reuses the SAME object reference for an unchanged conversation across merges", () => {
    sessionStore.mergeFromServer([{ id: "ref-a", title: "Alpha", createdAt: 1000, lastActivityAt: 1000 }]);
    const first = byId("ref-a");
    // A later poll returns the same conversation, unchanged.
    sessionStore.mergeFromServer([{ id: "ref-a", title: "Alpha", createdAt: 1000, lastActivityAt: 1000 }]);
    const second = byId("ref-a");
    // The same reference lets React.memo skip the row.
    expect(second).toBe(first);
  });

  it("produces a NEW reference only for the conversation that actually changed", () => {
    sessionStore.mergeFromServer([
      { id: "ch-x", title: "X", createdAt: 1, lastActivityAt: 1 },
      { id: "ch-y", title: "Y", createdAt: 2, lastActivityAt: 2 },
    ]);
    const x1 = byId("ch-x");
    const y1 = byId("ch-y");
    // Only Y's title changes on the next poll.
    sessionStore.mergeFromServer([
      { id: "ch-x", title: "X", createdAt: 1, lastActivityAt: 1 },
      { id: "ch-y", title: "Y renamed", createdAt: 2, lastActivityAt: 2 },
    ]);
    expect(byId("ch-x")).toBe(x1);
    expect(byId("ch-y")).not.toBe(y1);
    expect(byId("ch-y")?.title).toBe("Y renamed");
  });
});

describe("link sources ownership (an upsert owns its own row's links, and only its own)", () => {
  const sourcesOf = (id: string) => sessionStore.get().sessions.find((s) => s.id === id)?.sources;
  const linksOf = (id: string) => sessionStore.get().sessions.find((s) => s.id === id)?.links;

  it("an upsert ADDS the links it carries, so an attached resource shows without a full-list read", () => {
    // The router re-reads the whole link set for every upsert it pushes, including the ones the
    // webhooks database's own trigger fires, so the frame is the complete answer for that row.
    sessionStore.mergeFromServer([{ id: "conv-1", sources: [] }]);
    sessionStore.mergeFromServer(
      [{ id: "conv-1", sources: ["github"], links: [{ source: "github", url: "u", title: "A PR" }] }],
      { fullList: false },
    );
    expect(sourcesOf("conv-1")).toEqual(["github"]);
    expect(linksOf("conv-1")).toHaveLength(1);
  });

  it("an upsert CLEARS links when the last one is detached", () => {
    // The removal has no other way to reach the sidebar once the poll is gone: an upsert that
    // kept the old links would leave a provider icon for a link that no longer exists.
    sessionStore.mergeFromServer([{ id: "conv-2", sources: ["github"] }]);
    sessionStore.mergeFromServer([{ id: "conv-2", sources: [] }], { fullList: false });
    expect(sourcesOf("conv-2")).toEqual([]);
  });

  it("an upsert for ONE row leaves another row's links alone", () => {
    sessionStore.mergeFromServer([
      { id: "conv-3", sources: ["github"] },
      { id: "conv-4", sources: ["slack"] },
    ]);
    sessionStore.mergeFromServer([{ id: "conv-3", sources: [] }], { fullList: false });
    expect(sourcesOf("conv-3")).toEqual([]);
    expect(sourcesOf("conv-4"), "a single-row upsert says nothing about other rows").toEqual(["slack"]);
  });

  it("a row the read mentions without `sources` keeps the ones it has", () => {
    // Field ownership is "what this row's frame says", not "everything absent is empty", so a
    // reader that never populates sources cannot blank them.
    sessionStore.mergeFromServer([{ id: "conv-5", sources: ["jira"] }]);
    sessionStore.mergeFromServer([{ id: "conv-5" }]);
    expect(sourcesOf("conv-5")).toEqual(["jira"]);
  });
});

describe("editing lock (rename in progress freezes the sidebar — the CI rename flake)", () => {
  const byId = (id: string) => sessionStore.get().sessions.find((s) => s.id === id);

  it("a merge does NOT mutate the row being renamed (title/userTitled held)", () => {
    sessionStore.mergeFromServer([{ id: "edit-a", title: "Original", createdAt: 1, lastActivityAt: 1 }]);
    sessionStore.setEditing("edit-a");
    // An agent title landing mid-rename must be ignored for the editing row.
    sessionStore.mergeFromServer([{ id: "edit-a", title: "Agent-picked title", createdAt: 1, lastActivityAt: 1 }]);
    expect(byId("edit-a")?.title).toBe("Original");
    expect(byId("edit-a")?.userTitled).toBeFalsy();
  });

  it("keeps the SAME object reference for the editing row across a merge (React.memo skips it)", () => {
    sessionStore.mergeFromServer([{ id: "edit-ref", title: "Alpha", createdAt: 2, lastActivityAt: 2 }]);
    sessionStore.setEditing("edit-ref");
    const before = byId("edit-ref");
    // A merge that would otherwise change the title must not touch it.
    sessionStore.mergeFromServer([{ id: "edit-ref", title: "Changed by agent", createdAt: 2, lastActivityAt: 2 }]);
    expect(byId("edit-ref")).toBe(before);
  });

  it("freezes the WHOLE sidebar while renaming (a merge is a full no-op, not just per-row)", () => {
    sessionStore.mergeFromServer([
      { id: "lock-a", title: "A", createdAt: 1, lastActivityAt: 1 },
      { id: "lock-b", title: "B", createdAt: 2, lastActivityAt: 2 },
    ]);
    sessionStore.setEditing("lock-a");
    // While any rename is open, a merge that changes both the editing row and another row is dropped entirely.
    sessionStore.mergeFromServer([
      { id: "lock-a", title: "A changed", createdAt: 1, lastActivityAt: 1 },
      { id: "lock-b", title: "B changed", createdAt: 2, lastActivityAt: 2 },
    ]);
    expect(byId("lock-a")?.title).toBe("A");
    expect(byId("lock-b")?.title).toBe("B");
  });

  it("applies server-truth again once the rename clears", () => {
    sessionStore.mergeFromServer([{ id: "edit-clear", title: "Original", createdAt: 3, lastActivityAt: 3 }]);
    sessionStore.setEditing("edit-clear");
    sessionStore.mergeFromServer([{ id: "edit-clear", title: "Agent title", createdAt: 3, lastActivityAt: 3 }]);
    expect(byId("edit-clear")?.title).toBe("Original"); // held while editing
    // Once the lock clears the next merge applies again.
    sessionStore.clearEditing("edit-clear");
    sessionStore.mergeFromServer([{ id: "edit-clear", title: "Agent title", createdAt: 3, lastActivityAt: 3 }]);
    expect(byId("edit-clear")?.title).toBe("Agent title");
  });

  it("clearEditing(id) is a no-op when a DIFFERENT row is being edited", () => {
    sessionStore.mergeFromServer([{ id: "ce-a", title: "A", createdAt: 1, lastActivityAt: 1 }]);
    sessionStore.setEditing("ce-a");
    sessionStore.clearEditing("ce-b"); // stale clear from another row
    expect(sessionStore.get().editingId).toBe("ce-a");
    sessionStore.clearEditing("ce-a");
    expect(sessionStore.get().editingId).toBeUndefined();
  });

  it("RELEASES a lock whose row has left the rendered list (the freeze can't become permanent)", () => {
    sessionStore.mergeFromServer([
      { id: "stuck-a", title: "Alpha", createdAt: 1, lastActivityAt: 1 },
      { id: "stuck-b", title: "Beta", createdAt: 2, lastActivityAt: 2 },
    ]);
    sessionStore.setEditing("stuck-a");
    // The search hides the row being renamed, so its input unmounts and nothing can ever clear the lock from the row.
    sessionStore.setQuery("Beta");
    sessionStore.mergeFromServer([
      { id: "stuck-a", title: "Alpha changed", createdAt: 1, lastActivityAt: 1 },
      { id: "stuck-b", title: "Beta changed", createdAt: 2, lastActivityAt: 2 },
    ]);
    expect(sessionStore.get().editingId).toBeUndefined();
    expect(byId("stuck-a")?.title).toBe("Alpha changed"); // the merge ran as well as the unlock
    expect(byId("stuck-b")?.title).toBe("Beta changed");
  });

  it("a user rename made during editing survives the merge that arrives before clear", () => {
    sessionStore.mergeFromServer([{ id: "edit-user", title: "Original", createdAt: 4, lastActivityAt: 4 }]);
    sessionStore.setEditing("edit-user");
    sessionStore.renameSession("edit-user", "My pinned project"); // optimistic and locked
    // A poll still reporting the agent's guess arrives before the input closes.
    sessionStore.mergeFromServer([{ id: "edit-user", title: "Agent guess", createdAt: 4, lastActivityAt: 4 }]);
    expect(byId("edit-user")?.title).toBe("My pinned project");
    expect(byId("edit-user")?.userTitled).toBe(true);
  });
});

describe("per-conversation model (model-switch scoping)", () => {
  it("THE AGENT'S SWITCH STANDS: a synced model never overrides a newer server model", () => {
    sessionStore.mergeFromServer([{ id: "a", model: "claude-sonnet-5" }]);
    // The agent escalates; the server reports it.
    sessionStore.mergeFromServer([{ id: "a", model: "claude-fable-5-1" }]);
    const a = sessionStore.get().sessions.find((s) => s.id === "a")!;
    expect(a.model).toBe("claude-fable-5-1");
    expect(a.pendingModel, "nothing for the next prompt to send").toBeUndefined();
  });

  it("an UNSENT pick is shown and kept until a prompt carries it", () => {
    sessionStore.mergeFromServer([{ id: "a", model: "claude-sonnet-5" }]);
    sessionStore.setModel("a", "claude-opus-5-5");
    sessionStore.mergeFromServer([{ id: "a", model: "claude-sonnet-5" }]);
    let a = sessionStore.get().sessions.find((s) => s.id === "a")!;
    expect(a.model).toBe("claude-opus-5-5");
    expect(a.pendingModel).toBe("claude-opus-5-5");

    sessionStore.modelSent("a", "claude-opus-5-5");
    a = sessionStore.get().sessions.find((s) => s.id === "a")!;
    expect(a.pendingModel).toBeUndefined();
  });

  it("a stale send acknowledgement does not clear a newer pick", () => {
    sessionStore.mergeFromServer([{ id: "a" }]);
    sessionStore.setModel("a", "claude-opus-5-5");
    sessionStore.setModel("a", "claude-sonnet-5");
    sessionStore.modelSent("a", "claude-opus-5-5");
    expect(sessionStore.get().sessions.find((s) => s.id === "a")!.pendingModel).toBe("claude-sonnet-5");
  });

  it("setModel changes ONLY the target conversation, never the others", () => {
    sessionStore.mergeFromServer([{ id: "a" }, { id: "b" }, { id: "c" }]);
    sessionStore.setModel("a", "claude-sonnet-4-6");

    const byId = Object.fromEntries(sessionStore.get().sessions.map((s) => [s.id, s.model]));
    expect(byId.a).toBe("claude-sonnet-4-6");
    expect(byId.b).toBeUndefined();
    expect(byId.c).toBeUndefined();
  });

  it("a background list-refresh does NOT propagate one conversation's model to the rest", () => {
    // After switching A, a poll arrives and B/C must keep their own unset model.
    sessionStore.mergeFromServer([{ id: "a" }, { id: "b" }, { id: "c" }]);
    sessionStore.setModel("a", "claude-sonnet-4-6");

    // The poll reports A's persisted pick and no model for B/C.
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
    // A switch made before the first prompt persists it must not be clobbered by a poll that still reports no model.
    sessionStore.mergeFromServer([{ id: "a" }]);
    sessionStore.setModel("a", "claude-haiku-4-5");
    sessionStore.mergeFromServer([{ id: "a" /* server hasn't stored the model yet */ }]);
    expect(sessionStore.get().sessions.find((s) => s.id === "a")?.model).toBe("claude-haiku-4-5");
  });

  it("switching conversations does not carry a model between them (switchTo is model-neutral)", () => {
    sessionStore.mergeFromServer([{ id: "a" }, { id: "b" }]);
    sessionStore.setModel("a", "claude-sonnet-4-6");
    sessionStore.switchTo("b");
    // B's model is still its own, not A's pick.
    expect(sessionStore.get().sessions.find((s) => s.id === "b")?.model).toBeUndefined();
    expect(sessionStore.get().currentId).toBe("b");
  });
});

describe("favoriting pins a conversation to the top of the list", () => {
  // Stars come from the folder store, which mirrors them in by server key.
  const star = (...keys: string[]) => sessionStore.setStarredKeys(new Set(keys));
  // Unique ids avoid cross-test accumulation in the singleton store, and `only` restricts the assertion to them.
  const only = (...ids: string[]) => sessionStore.get().sessions.filter((s) => ids.includes(s.id)).map((s) => s.id);

  it("starred conversations sort ABOVE unstarred ones (then most-recently-active first within each group)", () => {
    sessionStore.mergeFromServer([
      { id: "star-old", title: "Old", createdAt: 1_000, lastActivityAt: 1_000 },
      { id: "star-mid", title: "Mid", createdAt: 2_000, lastActivityAt: 2_000 },
      { id: "star-new", title: "New", createdAt: 3_000, lastActivityAt: 3_000 },
    ]);
    expect(only("star-new", "star-mid", "star-old")).toEqual(["star-new", "star-mid", "star-old"]);

    // Starring the oldest moves it to the top despite being least recent.
    star("star-old");
    expect(only("star-new", "star-mid", "star-old")).toEqual(["star-old", "star-new", "star-mid"]);
  });

  it("re-sorts immediately on toggle (no wait for a server merge)", () => {
    sessionStore.mergeFromServer([
      { id: "imm-a", title: "A", createdAt: 3_000, lastActivityAt: 3_000 },
      { id: "imm-b", title: "B", createdAt: 2_000, lastActivityAt: 2_000 },
      { id: "imm-c", title: "C", createdAt: 1_000, lastActivityAt: 1_000 },
    ]);
    star("imm-c", "imm-b");
    // Both starred rows sort above imm-a, most recently active first.
    expect(only("imm-a", "imm-b", "imm-c")).toEqual(["imm-b", "imm-c", "imm-a"]);
  });

  it("un-starring drops a conversation back into recency order", () => {
    sessionStore.mergeFromServer([
      { id: "un-a", title: "A", createdAt: 3_000, lastActivityAt: 3_000 },
      { id: "un-b", title: "B", createdAt: 2_000, lastActivityAt: 2_000 },
      { id: "un-c", title: "C", createdAt: 1_000, lastActivityAt: 1_000 },
    ]);
    star("un-a");
    expect(only("un-a", "un-b", "un-c")).toEqual(["un-a", "un-b", "un-c"]);
    star();
    expect(only("un-a", "un-b", "un-c")).toEqual(["un-a", "un-b", "un-c"]); // a @3000 is still most recent
  });

  it("a server merge keeps the folder store's stars", () => {
    sessionStore.mergeFromServer([
      { id: "poll-a", title: "A", createdAt: 3_000, lastActivityAt: 3_000 },
      { id: "poll-b", title: "B", createdAt: 1_000, lastActivityAt: 1_000 },
    ]);
    star("poll-b");
    sessionStore.mergeFromServer([
      { id: "poll-a", title: "A", createdAt: 3_000, lastActivityAt: 3_000 },
      { id: "poll-b", title: "B", createdAt: 1_000, lastActivityAt: 1_000 },
    ]);
    expect(only("poll-a", "poll-b")).toEqual(["poll-b", "poll-a"]);
    star();
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

    // The next poll omits the subagent because it ended.
    sessionStore.mergeFromServer([{ id: "parent-1", title: "Parent" }]);
    const ids = sessionStore.get().sessions.map((s) => s.id);
    expect(ids).toContain("parent-1");
    expect(ids).not.toContain("sub-1");
  });

  it("does NOT prune a top-level conversation missing from a single merge", () => {
    // A top-level conversation may just be filtered out of this scope.
    sessionStore.mergeFromServer([{ id: "top-1", title: "Real chat" }]);
    sessionStore.mergeFromServer([{ id: "other", title: "Other" }]);
    expect(sessionStore.get().sessions.some((s) => s.id === "top-1")).toBe(true);
  });
});

describe("a brand-new conversation survives the background merge", () => {
  it("does NOT drop the currently-selected 'New chat' the server hasn't seen yet", async () => {
    // A real server conversation exists for the merge to reconcile against.
    sessionStore.mergeFromServer([{ id: "server-conv", title: "Existing" }]);

    // "New chat" creates a pristine, server-unknown, selected session.
    const fresh = sessionStore.newSession();
    expect(sessionStore.get().currentId).toBe(fresh);

    // A poll that does not include the new chat must neither drop it nor move the selection.
    sessionStore.mergeFromServer([{ id: "server-conv", title: "Existing" }]);

    expect(sessionStore.get().sessions.some((s) => s.id === fresh)).toBe(true);
    expect(sessionStore.get().currentId).toBe(fresh);
  });

  it("still drops a pristine placeholder the user has LEFT (not selected)", () => {
    // Selecting the real conversation leaves the pristine placeholder as a genuine phantom.
    const pristine = sessionStore.get().currentId; // the initial fresh "New chat"
    sessionStore.mergeFromServer([{ id: "real", title: "Real" }]);
    sessionStore.switchTo("real");
    expect(sessionStore.get().currentId).toBe("real");

    // A later merge that still does not know the placeholder drops it.
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

    // The agent's new title is ignored because the title is locked.
    sessionStore.setTitle("c", "Agent's new guess");
    expect(titleOf("c")).toBe("My name");
  });

  it("a server userTitled merge wins over a stale local title immediately", () => {
    // The server reports a user rename over a local agent title.
    sessionStore.mergeFromServer([{ id: "c", title: "Agent guess" }]);
    sessionStore.mergeFromServer([{ id: "c", title: "Pinned by user", userTitled: true }]);
    expect(titleOf("c")).toBe("Pinned by user");
    expect(of("c")?.userTitled).toBe(true);
  });

  it("setStarredKeys mirrors the folder store's stars by server key", () => {
    sessionStore.mergeFromServer([{ id: "c", title: "X" }]);
    expect(of("c")?.starred).toBeFalsy();
    sessionStore.setStarredKeys(new Set(["c"]));
    expect(of("c")?.starred).toBe(true);
    sessionStore.setStarredKeys(new Set());
    expect(of("c")?.starred).toBeFalsy();
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
    // The id "anonymous" is truthy, so the filter must guard on the flag and keep every conversation visible.
    const t = titles();
    expect(t).toContain("Alice");
    expect(t).toContain("Bob");
    expect(t).toContain("Unowned");
  });

  it("a KNOWN user under Mine sees STRICTLY their own (not others, not unowned)", () => {
    seed();
    sessionStore.setCurrentUser({ id: "alice", email: "alice@x.io", anonymous: false });
    sessionStore.setScope("mine");
    // Bob's and every unowned conversation are hidden.
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
  const s = (id: string, parentId?: string): Session => ({ id, title: id, createdAt: 1, lastActivityAt: 1, parentId });

  it("with no activeId, expands every parent's children", () => {
    // Flat input with the children of p1 and p2 interleaved.
    const flat = [s("p1"), s("p2"), s("c1a", "p1"), s("c2a", "p2"), s("c1b", "p1")];
    const rows = nestSubagents(flat);
    expect(rows.map((r) => r.session.id)).toEqual(["p1", "c1a", "c1b", "p2", "c2a"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0, 1]);
  });

  it("AUTO-COLLAPSES a parent's children when neither the parent nor a child is active", () => {
    const flat = [s("p1"), s("c1a", "p1"), s("c1b", "p1"), s("p2"), s("c2a", "p2")];
    // p2 is active, so its children expand and p1 collapses.
    const rows = nestSubagents(flat, "p2");
    expect(rows.map((r) => r.session.id)).toEqual(["p1", "p2", "c2a"]);
    // The collapsed parent carries its child count.
    expect(rows.find((r) => r.session.id === "p1")?.childCount).toBe(2);
    // The expanded parent has no hidden children.
    expect(rows.find((r) => r.session.id === "p2")?.childCount).toBe(0);
  });

  it("expands a parent's children when a CHILD is the active conversation", () => {
    const flat = [s("p1"), s("c1a", "p1"), s("c1b", "p1"), s("p2"), s("c2a", "p2")];
    // c1a is a child of p1, so p1's branch expands and p2 collapses.
    const rows = nestSubagents(flat, "c1a");
    expect(rows.map((r) => r.session.id)).toEqual(["p1", "c1a", "c1b", "p2"]);
  });

  it("a child whose parent is NOT in the list renders as a top-level row", () => {
    // The parent was filtered out, so the orphaned child still shows.
    const rows = nestSubagents([s("orphan", "missing-parent")]);
    expect(rows.map((r) => r.session.id)).toEqual(["orphan"]);
    expect(rows[0].depth).toBe(0);
  });

  it("top-level-only list is unchanged (all depth 0)", () => {
    const rows = nestSubagents([s("a"), s("b")]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });
});

describe("a phantom local conversation never shadows its real server row", () => {
  it("prunes a never-created row the server does not list (once it is not the selection)", () => {
    // A row with a title but no server id can only shadow the conversation it was meant to become.
    const ghost = sessionStore.newSession();
    sessionStore.setTitle(ghost, "lost create");
    sessionStore.mergeFromServer([{ id: "phantom-real", title: "lost create" }]);
    sessionStore.switchTo("phantom-real");
    sessionStore.mergeFromServer([{ id: "phantom-real", title: "lost create" }]);

    const listed = sessionStore.get().sessions.map((s) => s.id);
    expect(listed).toContain("phantom-real");
    expect(listed).not.toContain(ghost);
  });

  it("keeps it while it IS the selection (an unsent conversation being typed into)", () => {
    const draft = sessionStore.newSession();
    sessionStore.setTitle(draft, "typing right now");
    sessionStore.mergeFromServer([{ id: "phantom-other", title: "Other" }]);
    expect(sessionStore.get().sessions.map((s) => s.id)).toContain(draft);
  });

  it("keeps a SERVER-created conversation that a single merge does not mention", () => {
    // A real conversation missing from one merge may just be scoped out.
    sessionStore.mergeFromServer([{ id: "phantom-kept", title: "Real chat" }]);
    sessionStore.mergeFromServer([{ id: "phantom-else", title: "Else" }]);
    expect(sessionStore.get().sessions.map((s) => s.id)).toContain("phantom-kept");
  });
});

describe("the SERVER owns conversation ids", () => {
  it("newSession() selects the new conversation SYNCHRONOUSLY (no server round-trip)", () => {
    // A server round-trip here would leave a fast typist sending into the previous conversation.
    const mint = vi.fn(async () => "must-not-be-called-yet");
    setConversationMinter(mint);

    const id = sessionStore.newSession();

    expect(mint).not.toHaveBeenCalled();
    expect(sessionStore.get().currentId).toBe(id);
    expect(sessionStore.current().serverCreated).toBe(false);
  });

  it("the server id is RECORDED on the first send — the stable key does not change", async () => {
    // The server id is recorded alongside the key everything is mounted on, not in place of it.
    sessionStore.newSession();
    const key = sessionStore.get().currentId;
    setConversationMinter(async () => "server-assigned-id");

    const id = await sessionStore.ensureCurrentCreated();

    expect(id).toBe("server-assigned-id");
    expect(sessionStore.get().currentId).toBe(key);
    expect(sessionStore.current().serverId).toBe("server-assigned-id");
    expect(sessionStore.current().serverCreated).toBe(true);
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

  it("a locally-seeded conversation gets a server id without changing its key", async () => {
    // freshState() and deleteSession() seed conversations whose keys are local placeholders.
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    const key = sessionStore.get().currentId;
    expect(sessionStore.current().serverCreated).toBeFalsy();
    expect(sessionStore.current().serverId).toBeUndefined();

    setConversationMinter(async () => "real-id");
    const id = await sessionStore.ensureCurrentCreated();

    expect(id).toBe("real-id");
    expect(sessionStore.get().currentId).toBe(key); // unchanged, so nothing is remounted
    expect(sessionStore.current().serverId).toBe("real-id");
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
    // Every mount asks, so overlapping calls must share one POST /conversations.
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

  it("a conversation rebuilt after a RELOAD addresses the server by its SERVER id", async () => {
    // A reload rebuilds every Conversation from the persisted session, whose key may be a local placeholder.
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    setConversationMinter(async () => "real-server-id");
    await sessionStore.ensureCurrentCreated();

    const key = sessionStore.get().currentId;
    const persisted = sessionStore.current();
    expect(persisted.serverId).toBe("real-server-id");
    expect(key).not.toBe("real-server-id"); // the key stayed local

    // Rebuild from the persisted record alone, as a reload would.
    const rebuilt = conversationFor(persisted);
    expect(rebuilt.serverId()).toBe("real-server-id");
    expect(rebuilt.key).toBe(key);
    expect(await rebuilt.ifCreated(async (id) => id, "not-created")).toBe("real-server-id");
  });

  it("a merge does NOT duplicate a conversation created on its first send", async () => {
    // The merge is keyed by server id, while a conversation created on its first send keeps its local key.
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    setConversationMinter(async () => "server-abc");
    await sessionStore.ensureCurrentCreated();
    const key = sessionStore.get().currentId;

    // The poll returns that conversation under its server id.
    sessionStore.mergeFromServer([{ id: "server-abc", title: "From the server" }]);

    expect(sessionStore.get().sessions).toHaveLength(1);
    // The merge did not swap the stable key out from under the mounted runtime.
    expect(sessionStore.get().currentId).toBe(key);
    expect(sessionStore.current().serverId).toBe("server-abc");
    expect(sessionStore.current().title).toBe("From the server");
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

describe("the local key must never be used as a server id", () => {
  it("a pending conversation exposes NO server id to address the server with", async () => {
    // An uncreated conversation has nothing that can be sent to the server.
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    const key = sessionStore.get().currentId;
    const conv = conversationFor(sessionStore.current());

    expect(conv.serverId()).toBeUndefined();
    expect(conv.url("/events.integrity")).toBeUndefined();
    expect(conv.shareUrl("https://x")).toBeUndefined();
    // The key exists for React and selection, and is not a server id.
    expect(conv.key).toBe(key);
  });

  it("once created, every address uses the SERVER id", async () => {
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    const key = sessionStore.get().currentId;
    setConversationMinter(async () => "real-server-id");
    await sessionStore.ensureCurrentCreated();

    const conv = conversationFor(sessionStore.current());
    expect(conv.url("/tail")).toContain("/conversations/real-server-id/tail");
    expect(conv.shareUrl("https://x")).toBe("https://x/?thread=real-server-id");
    expect(conv.url("/tail")).not.toContain(key);
    expect(conv.shareUrl("https://x")).not.toContain(key);
  });
});

describe("a bare URL starts on a new conversation (startFresh)", () => {
  it("leaves the server-backed conversation behind and selects an unnamed one", () => {
    sessionStore.mergeFromServer([{ id: "prior", title: "Yesterday's work" }]);
    sessionStore.requestSelect("prior");
    expect(sessionStore.get().currentId).toBe("prior");

    sessionStore.startFresh();
    const { sessions, currentId } = sessionStore.get();
    expect(currentId).not.toBe("prior");
    expect(sessions.find((s) => s.id === currentId)!.title).toBe("New chat");
    // The prior conversation is still listed, just not selected.
    expect(sessions.some((s) => s.id === "prior")).toBe(true);
  });

  it("reuses an untouched conversation rather than stacking another beside it", () => {
    const first = sessionStore.startFresh();
    // The store is a module singleton, so assert a delta, not a total.
    const rows = sessionStore.get().sessions.length;
    const again = sessionStore.startFresh();
    expect(again).toBe(first);
    expect(sessionStore.get().sessions).toHaveLength(rows);
  });
});

describe("removeFromServer (the stream's remove frame)", () => {
  it("drops the row the server says is gone, keyed by SERVER id", () => {
    sessionStore.mergeFromServer([{ id: "keep-1" }, { id: "gone-1" }]);
    sessionStore.removeFromServer("gone-1");
    // The store is a module singleton, so assert on these two rows rather than the whole list.
    const ids = sessionStore.get().sessions.map((s) => s.serverId);
    expect(ids).toContain("keep-1");
    expect(ids).not.toContain("gone-1");
  });

  it("matches a conversation created locally, whose key is NOT its server id", () => {
    // A conversation created on first send keys by a local id and carries serverId separately.
    const local = sessionStore.get().currentId;
    sessionStore.mergeFromServer([{ id: "server-xyz" }]);
    const row = sessionStore.get().sessions.find((s) => s.serverId === "server-xyz");
    expect(row?.id).toBeDefined();

    sessionStore.removeFromServer("server-xyz");
    expect(sessionStore.get().sessions.some((s) => s.serverId === "server-xyz")).toBe(false);
    expect(local).toBeDefined();
  });

  it("is a no-op for a conversation it never had", () => {
    sessionStore.mergeFromServer([{ id: "a" }, { id: "b" }]);
    const before = sessionStore.get();
    sessionStore.removeFromServer("never-seen");
    expect(sessionStore.get()).toBe(before); // same reference: no re-render
  });

  it("defers the removal while a rename is open, then applies it when the lock clears", () => {
    // Reconciling mid-rename detaches the inline input, which is why mergeFromServer pauses
    // too — but the frame cannot be discarded: the stream sends it once and nothing polls.
    sessionStore.mergeFromServer([{ id: "r-1" }, { id: "r-2" }]);
    const target = sessionStore.get().sessions.find((s) => s.serverId === "r-1")!;
    sessionStore.setEditing(target.id);
    sessionStore.removeFromServer("r-1");
    expect(sessionStore.get().sessions.some((s) => s.serverId === "r-1"), "the input must survive").toBe(true);

    sessionStore.clearEditing();
    expect(
      sessionStore.get().sessions.some((s) => s.serverId === "r-1"),
      "a deferred removal must not be lost when the rename ends",
    ).toBe(false);
  });

  it("defers a removal for a DIFFERENT row than the one being renamed", () => {
    // The lock is about re-rendering the sidebar at all, not about which row is gone.
    sessionStore.mergeFromServer([{ id: "r-3" }, { id: "r-4" }]);
    const editing = sessionStore.get().sessions.find((s) => s.serverId === "r-3")!;
    sessionStore.setEditing(editing.id);
    sessionStore.removeFromServer("r-4");
    expect(sessionStore.get().sessions.some((s) => s.serverId === "r-4")).toBe(true);
    sessionStore.clearEditing();
    expect(sessionStore.get().sessions.some((s) => s.serverId === "r-4")).toBe(false);
  });

  it("applies every deferred removal, and a repeat of one only once", () => {
    sessionStore.mergeFromServer([{ id: "r-5" }, { id: "r-6" }, { id: "r-7" }]);
    const editing = sessionStore.get().sessions.find((s) => s.serverId === "r-5")!;
    sessionStore.setEditing(editing.id);
    sessionStore.removeFromServer("r-6");
    sessionStore.removeFromServer("r-7");
    sessionStore.removeFromServer("r-6"); // a reconnect can re-deliver the same removal
    sessionStore.clearEditing();
    const ids = sessionStore.get().sessions.map((s) => s.serverId);
    expect(ids).not.toContain("r-6");
    expect(ids).not.toContain("r-7");
    expect(ids).toContain("r-5");
  });

  it("applies deferred removals when a merge is what releases the lock", () => {
    // The lock also clears from mergeFromServer, once the row being renamed is no longer
    // rendered; a removal queued behind it must drain there too, not only via clearEditing.
    sessionStore.mergeFromServer([{ id: "r-8" }, { id: "r-9" }]);
    const editing = sessionStore.get().sessions.find((s) => s.serverId === "r-8")!;
    sessionStore.setEditing(editing.id);
    sessionStore.removeFromServer("r-9");
    // The renamed row stops being rendered, so the next merge releases the lock. The merge is
    // a single-row upsert, which says nothing about r-9's membership — only the queued remove
    // frame does, so the flush is the one thing that can drop it.
    sessionStore.deleteSession(editing.id);
    sessionStore.mergeFromServer([{ id: "r-10" }], { fullList: false });
    const ids = sessionStore.get().sessions.map((s) => s.serverId);
    expect(ids).not.toContain("r-9");
    expect(ids, "the upsert that released the lock still applies").toContain("r-10");
  });

  it("applies a deferred UPSERT, so a rename elsewhere is not lost behind the lock", () => {
    // A rename in another tab arrives as an upsert frame. The lock suppresses the re-render,
    // but the stream sends that frame once and nothing polls behind it, so dropping it leaves
    // this tab showing the old title for as long as the lock holds — which, for an input left
    // open, is until a reload.
    sessionStore.mergeFromServer([{ id: "u-1", title: "Old name" }, { id: "u-2" }]);
    const editing = sessionStore.get().sessions.find((s) => s.serverId === "u-2")!;
    sessionStore.setEditing(editing.id);
    sessionStore.mergeFromServer([{ id: "u-1", title: "New name", userTitled: true }], { fullList: false });
    expect(
      sessionStore.get().sessions.find((s) => s.serverId === "u-1")!.title,
      "the merge is held back while the input is open",
    ).toBe("Old name");
    sessionStore.clearEditing();
    expect(sessionStore.get().sessions.find((s) => s.serverId === "u-1")!.title).toBe("New name");
  });

  it("keeps only the NEWEST queued frame per conversation", () => {
    // An upsert and a removal of one row are contradictory; replaying both in arrival order
    // would resurrect a deleted row (or bury a live one), so the later frame is the truth.
    sessionStore.mergeFromServer([{ id: "u-3", title: "First" }, { id: "u-4" }]);
    const editing = sessionStore.get().sessions.find((s) => s.serverId === "u-4")!;
    sessionStore.setEditing(editing.id);
    sessionStore.removeFromServer("u-3");
    sessionStore.mergeFromServer([{ id: "u-3", title: "Back again", userTitled: true }], { fullList: false });
    sessionStore.clearEditing();
    const row = sessionStore.get().sessions.find((s) => s.serverId === "u-3");
    expect(row, "the re-add came after the removal, so the row lives").toBeDefined();
    expect(row!.title).toBe("Back again");
  });

  it("lets a queued SNAPSHOT supersede the frames it already accounts for", () => {
    // A reconnect's snapshot is complete truth, so anything queued before it is stale; the
    // queue is also what bounds growth while a lock is held open.
    sessionStore.mergeFromServer([{ id: "u-5" }, { id: "u-6" }]);
    const editing = sessionStore.get().sessions.find((s) => s.serverId === "u-6")!;
    sessionStore.setEditing(editing.id);
    sessionStore.mergeFromServer([{ id: "u-5", title: "Mid-flight", userTitled: true }], { fullList: false });
    sessionStore.mergeFromServer([{ id: "u-5", title: "Snapshot title", userTitled: true }, { id: "u-6" }]);
    sessionStore.clearEditing();
    expect(sessionStore.get().sessions.find((s) => s.serverId === "u-5")!.title).toBe("Snapshot title");
  });

  it("never empties the list, so the UI always has a conversation to show", () => {
    sessionStore.mergeFromServer([{ id: "only-1" }]);
    for (const s of [...sessionStore.get().sessions]) {
      if (s.serverId) sessionStore.removeFromServer(s.serverId);
    }
    expect(sessionStore.get().sessions.length).toBeGreaterThan(0);
  });

  it("re-selects when the removed conversation was the current one", () => {
    sessionStore.mergeFromServer([{ id: "cur" }, { id: "other" }]);
    const cur = sessionStore.get().sessions.find((s) => s.serverId === "cur")!;
    sessionStore.switchTo(cur.id);
    expect(sessionStore.get().currentId).toBe(cur.id);

    sessionStore.removeFromServer("cur");
    expect(sessionStore.get().currentId).not.toBe(cur.id);
    expect(sessionStore.get().sessions.some((s) => s.serverId === "cur")).toBe(false);
  });
});

describe("hover hold on a row's action tiles", () => {
  const order = () => sessionStore.get().sessions.map((x) => x.serverId);

  it("holds a reorder while the pointer is on a row's actions, then applies it on leave", () => {
    // An agent's activity bumps its conversation to the top; doing that under the pointer
    // slides a different row beneath a star/rename click.
    sessionStore.mergeFromServer([
      { id: "h-1", lastActivityAt: 200 },
      { id: "h-2", lastActivityAt: 100 },
    ]);
    const hovered = sessionStore.get().sessions.find((x) => x.serverId === "h-1")!;
    sessionStore.setHover(hovered.id);
    sessionStore.mergeFromServer([{ id: "h-2", lastActivityAt: 300 }], { fullList: false });
    expect(order().filter((id) => id === "h-1" || id === "h-2"), "no reorder under the pointer").toEqual(["h-1", "h-2"]);

    sessionStore.clearHover(hovered.id);
    expect(order().filter((id) => id === "h-1" || id === "h-2"), "the held reorder lands on leave").toEqual(["h-2", "h-1"]);
  });

  it("ignores a stale release from a row that does not hold it", () => {
    sessionStore.mergeFromServer([{ id: "h-3" }, { id: "h-4" }]);
    const [a, b] = ["h-3", "h-4"].map((id) => sessionStore.get().sessions.find((x) => x.serverId === id)!);
    sessionStore.setHover(a.id);
    sessionStore.clearHover(b.id);
    expect(sessionStore.get().hoverId).toBe(a.id);
  });

  it("opening a rename takes over the hold, since the action tiles unmount", () => {
    sessionStore.mergeFromServer([{ id: "h-5" }, { id: "h-6" }]);
    const row = sessionStore.get().sessions.find((x) => x.serverId === "h-5")!;
    sessionStore.setHover(row.id);
    sessionStore.setEditing(row.id);
    expect(sessionStore.get().hoverId).toBeUndefined();
    sessionStore.mergeFromServer([{ id: "h-6", title: "Renamed elsewhere", userTitled: true }], { fullList: false });
    sessionStore.clearEditing(row.id);
    expect(sessionStore.get().sessions.find((x) => x.serverId === "h-6")!.title).toBe("Renamed elsewhere");
  });

  it("keeps frames queued until BOTH the rename and the hover hold are released", () => {
    sessionStore.mergeFromServer([{ id: "h-7" }, { id: "h-8" }]);
    const [a, b] = ["h-7", "h-8"].map((id) => sessionStore.get().sessions.find((x) => x.serverId === id)!);
    sessionStore.setEditing(a.id);
    sessionStore.setHover(b.id);
    sessionStore.removeFromServer("h-8");
    sessionStore.clearEditing(a.id);
    expect(order(), "the hover still holds").toContain("h-8");
    sessionStore.clearHover(b.id);
    expect(order()).not.toContain("h-8");
  });

  it("keeps a live hover hold when only the rename row has gone stale", () => {
    sessionStore.mergeFromServer([
      { id: "h-11", title: "alpha" },
      { id: "h-12", title: "beta" },
    ]);
    const [a, b] = ["h-11", "h-12"].map((id) => sessionStore.get().sessions.find((x) => x.serverId === id)!);
    sessionStore.setEditing(a.id);
    sessionStore.setHover(b.id);
    sessionStore.setQuery("beta"); // the rename row is filtered out; the hovered one stays
    sessionStore.mergeFromServer([{ id: "h-12", title: "Held", userTitled: true }], { fullList: false });
    expect(sessionStore.get().editingId).toBeUndefined();
    expect(sessionStore.get().hoverId).toBe(b.id);
    expect(sessionStore.get().sessions.find((x) => x.serverId === "h-12")!.title, "still held").toBe("beta");
    sessionStore.clearHover(b.id);
    expect(sessionStore.get().sessions.find((x) => x.serverId === "h-12")!.title).toBe("Held");
  });

  it("releases the hold once the hovered row is no longer rendered", () => {
    // Nothing would fire pointerleave for a row that is gone, so a merge must not queue forever.
    sessionStore.mergeFromServer([{ id: "h-9" }, { id: "h-10" }]);
    const row = sessionStore.get().sessions.find((x) => x.serverId === "h-9")!;
    sessionStore.setHover(row.id);
    sessionStore.setQuery("no-such-title");
    sessionStore.mergeFromServer([{ id: "h-10", title: "Lands", userTitled: true }], { fullList: false });
    sessionStore.setQuery("");
    expect(sessionStore.get().hoverId).toBeUndefined();
    expect(sessionStore.get().sessions.find((x) => x.serverId === "h-10")!.title).toBe("Lands");
  });
});

describe("a draft whose first send is still creating it", () => {
  /** A minter held open until `release` is called, standing in for a slow POST /conversations. */
  const slowMinter = (id: string) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setConversationMinter(async () => {
      await gate;
      return id;
    });
    return () => release();
  };
  const row = (key: string) => sessionStore.get().sessions.find((s) => s.id === key)!;

  it("is not reused by startFresh, so New conversation opens a separate draft", async () => {
    const release = slowMinter("slow-1");
    const sent = sessionStore.startFresh();
    const create = conversationFor(row(sent)).ensureCreated();

    const next = sessionStore.startFresh();
    expect(next).not.toBe(sent);
    expect(sessionStore.get().currentId).toBe(next);

    release();
    await create;
    expect(row(sent).serverId).toBe("slow-1");
  });

  it("survives a full-list merge read before the create landed, so its server id has a row to land on", async () => {
    const release = slowMinter("slow-2");
    const sent = sessionStore.startFresh();
    const create = conversationFor(row(sent)).ensureCreated();
    sessionStore.newSession(); // selection moves away

    sessionStore.mergeFromServer([{ id: "slow-other", title: "Other" }]);
    expect(sessionStore.get().sessions.some((s) => s.id === sent)).toBe(true);

    release();
    await create;
    expect(row(sent).serverId).toBe("slow-2");
  });
});

describe("clicking New conversation twice (startFresh)", () => {
  it("leaves one unsent draft, not two", () => {
    const before = sessionStore.get().sessions.length;
    const a = sessionStore.startFresh();
    const grew = sessionStore.get().sessions.length - before;
    const b = sessionStore.startFresh();
    expect(b).toBe(a);
    expect(sessionStore.get().sessions.length - before).toBe(grew);
  });
});
