/**
 * Subagent conversations in the sidebar and the parent's panel.
 *
 * A subagent is a full conversation that shares its parent's sandbox; it renders
 * nested under its parent, the parent's Subagents panel lists it, and it stays listed
 * until the server says it ended. A conversation started in this tab keeps a local
 * placeholder key for life (`id` is a client UUID, `serverId` the server's) while a
 * subagent's `parentId` is a server id, so every parent/child lookup must compare
 * against the server id. `mergeFromServer` is called with an authoritative full list
 * (the poll, the SSE snapshot) and with a single-row SSE upsert, and absence means
 * "ended" only in the former.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  sessionStore,
  setConversationMinter,
  filteredSessions,
  nestSubagents,
  type Session,
} from "./sessions.js";
import { familyOf } from "./family.js";

// The children a parent's Chats panel lists.
const childrenIn = (all: Session[], id: string | undefined) => familyOf(all, id).slice(1).map((m) => m.session);

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  sessionStore.clearEditing();
  sessionStore.setQuery("");
  sessionStore.clearProviders();
  sessionStore.setScope("all");
});

/** A session as the store holds it; pass `serverId` explicitly to model a locally-started conversation whose key never became its id. */
const s = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  title: id,
  createdAt: 1,
  lastActivityAt: 1,
  serverId: id,
  ...over,
});

describe("a subagent nests under the parent that spawned it", () => {
  it("nests under a SERVER-SOURCED parent (key === server id)", () => {
    const rows = nestSubagents([s("parent"), s("child", { parentId: "parent" })]);
    expect(rows.map((r) => [r.session.id, r.depth])).toEqual([
      ["parent", 0],
      ["child", 1],
    ]);
  });

  it("nests under a parent the user STARTED IN THIS TAB (local key ≠ server id)", () => {
    // The parent's key is a client UUID; the server id its subagents carry as parentId
    // is on `serverId`.
    const parent = s("local-key-abc", { serverId: "srv-parent", title: "Parent" });
    const child = s("srv-child", { parentId: "srv-parent", title: "Subagent" });

    const rows = nestSubagents([parent, child]);

    expect(rows.map((r) => r.session.id)).toEqual(["local-key-abc", "srv-child"]);
    expect(
      rows.find((r) => r.session.id === "srv-child")?.depth,
      "a subagent must render nested under its parent, not as an independent conversation",
    ).toBe(1);
  });

  it("AUTO-COLLAPSE keys off the parent's server id too", () => {
    // Another conversation is active, so the locally-keyed parent collapses and must
    // report its child count.
    const parent = s("local-key-abc", { serverId: "srv-parent" });
    const child = s("srv-child", { parentId: "srv-parent" });
    const other = s("other");

    const rows = nestSubagents([parent, child, other], "other");

    expect(rows.map((r) => r.session.id)).toEqual(["local-key-abc", "other"]);
    expect(rows.find((r) => r.session.id === "local-key-abc")?.childCount).toBe(1);
  });

  it("expands the branch when the ACTIVE conversation is the locally-keyed parent", () => {
    const parent = s("local-key-abc", { serverId: "srv-parent" });
    const child = s("srv-child", { parentId: "srv-parent" });
    // activeId is the stable key, which the sidebar tracks selection by.
    const rows = nestSubagents([parent, child], "local-key-abc");
    expect(rows.map((r) => r.session.id)).toEqual(["local-key-abc", "srv-child"]);
    expect(rows[1].depth).toBe(1);
  });
});

describe("the parent's Chats panel finds its children", () => {
  it("lists children of a SERVER-SOURCED parent", () => {
    const all = [s("parent"), s("c1", { parentId: "parent" }), s("c2", { parentId: "parent" }), s("other")];
    expect(childrenIn(all, "parent").map((x) => x.id)).toEqual(["c1", "c2"]);
  });

  it("lists children of a parent the user started in this tab (local key)", () => {
    // subagentsOf receives the store's currentId (the stable key) while the children
    // carry the parent's server id.
    const all = [
      s("local-key-abc", { serverId: "srv-parent" }),
      s("srv-child", { parentId: "srv-parent" }),
      s("other"),
    ];
    expect(
      childrenIn(all, "local-key-abc").map((x) => x.id),
      "the Chats panel must resolve the current conversation's SERVER id",
    ).toEqual(["srv-child"]);
  });

  it("returns [] when there is no current conversation", () => {
    expect(childrenIn([s("a")], undefined)).toEqual([]);
  });
});

describe("a live SSE upsert must not evict subagents", () => {
  it("keeps a subagent when a DIFFERENT conversation upserts", () => {
    // Authoritative snapshot: a parent with a running subagent, plus another chat.
    sessionStore.mergeFromServer([
      { id: "parent-1", title: "Parent" },
      { id: "sub-1", title: "research", parentId: "parent-1" },
      { id: "other-1", title: "Other" },
    ]);
    expect(sessionStore.get().sessions.map((x) => x.id)).toContain("sub-1");

    // A single-row upsert for an unrelated conversation says nothing about sub-1, so
    // its absence is not evidence the subagent ended.
    sessionStore.mergeFromServer([{ id: "other-1", title: "Other renamed" }], {
      fullList: false,
    });

    const ids = sessionStore.get().sessions.map((x) => x.id);
    expect(ids, "a single-row upsert must not prune subagents it never mentioned").toContain("sub-1");
    expect(ids).toContain("parent-1");
  });

  it("still prunes an ended subagent on an AUTHORITATIVE list read", () => {
    sessionStore.mergeFromServer([
      { id: "parent-2", title: "Parent" },
      { id: "sub-2", title: "research", parentId: "parent-2" },
    ]);
    // The poll is authoritative, so the subagent's absence here does mean it is gone.
    sessionStore.mergeFromServer([{ id: "parent-2", title: "Parent" }]);
    const ids = sessionStore.get().sessions.map((x) => x.id);
    expect(ids).toContain("parent-2");
    expect(ids).not.toContain("sub-2");
  });

  it("APPLIES a subagent's own status upsert (running → ended)", () => {
    // A subagent's visible lifecycle is its status, so the merge's no-op guard must
    // treat a status-only change as a change.
    sessionStore.mergeFromServer([
      { id: "parent-3", title: "Parent" },
      { id: "sub-3", title: "research", parentId: "parent-3", status: "running" },
    ]);
    expect(sessionStore.get().sessions.find((x) => x.id === "sub-3")?.status).toBe("running");

    sessionStore.mergeFromServer([{ id: "sub-3", title: "research", parentId: "parent-3", status: "ended" }], {
      fullList: false,
    });

    const sub = sessionStore.get().sessions.find((x) => x.id === "sub-3");
    expect(sub?.status, "a status-only upsert must reach the store").toBe("ended");
    expect(sessionStore.get().sessions.map((x) => x.id)).toContain("parent-3");
  });
});

describe("the whole path: a chat started in THIS TAB spawns a subagent", () => {
  it("nests the subagent and shows it in the parent's panel", async () => {
    // 1. The user sends from a new chat; the server mints the id and the row keeps its
    //    local key.
    sessionStore.newSession();
    const key = sessionStore.get().currentId;
    setConversationMinter(async () => "srv-parent");
    await sessionStore.ensureCurrentCreated();
    expect(sessionStore.current().serverId).toBe("srv-parent");
    expect(key, "the stable key must NOT become the server id").not.toBe("srv-parent");

    // 2. The agent spawns a subagent, which reaches the UI as an SSE upsert carrying
    //    the parent's server id.
    sessionStore.mergeFromServer(
      [{ id: "srv-sub", title: "research the thing", parentId: "srv-parent", status: "running" }],
      { fullList: false },
    );

    // 3. The sidebar shows it as a child of the active (so expanded) parent, not as a
    //    second top-level conversation.
    const rows = nestSubagents(filteredSessions(sessionStore.get()), sessionStore.get().currentId);
    const sub = rows.find((r) => r.session.id === "srv-sub");
    expect(sub, "the subagent must be listed").toBeTruthy();
    expect(sub!.depth, "a subagent must never render as an independent top-level chat").toBe(1);
    // It sits directly under its parent; the store is a module singleton holding other
    // tests' rows, so assert relative position rather than the whole list.
    const ids = rows.map((r) => r.session.id);
    expect(ids[ids.indexOf("srv-sub") - 1]).toBe(key);

    // 4. The parent's Chats panel finds it.
    expect(childrenIn(sessionStore.get().sessions, sessionStore.get().currentId).map((x) => x.id)).toEqual([
      "srv-sub",
    ]);

    // 5. An unrelated upsert (another chat retitled) must not evict the subagent.
    sessionStore.mergeFromServer([{ id: "srv-other", title: "Unrelated" }], { fullList: false });
    expect(sessionStore.get().sessions.map((x) => x.id)).toContain("srv-sub");
  });
});
