/**
 * Tier 1 (ui) — SUBAGENT conversations in the sidebar and the parent's panel.
 *
 * A subagent is a full conversation that shares its parent's sandbox. The UI
 * contract for one is narrow and easy to break silently:
 *
 *   1. it renders NESTED under its parent (depth 1), never as an independent
 *      top-level row;
 *   2. the parent's Subagents panel lists it (the "sub-conversation" view);
 *   3. it stays listed until the SERVER says it ended.
 *
 * Every existing test builds its fixtures with `id === the server's id`, which is
 * true only for conversations the UI learned about from the server. A conversation
 * the user STARTS IN THIS TAB keeps a local placeholder key for its whole life
 * (`id` is a client UUID, `serverId` is the server's) — and `parentId` on a
 * subagent is a SERVER id. So every parent↔child lookup that compares `parentId`
 * to `s.id` silently fails for exactly the conversations users actually type into.
 * These tests pin the relationship to the SERVER id on both sides.
 *
 * The other half is the merge: `mergeFromServer` is called both with an
 * authoritative full list (the 10s poll, the SSE connect snapshot) and with a
 * SINGLE-ROW SSE `upsert`. Absence means "ended" only in the former.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  sessionStore,
  setConversationMinter,
  filteredSessions,
  nestSubagents,
  type Session,
} from "./sessions.js";
import { subagentsOf } from "./SubagentsPanel.js";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  sessionStore.clearEditing();
  sessionStore.setQuery("");
  sessionStore.clearProviders();
  sessionStore.setScope("all");
});

/** A session as the store holds it. `serverId` defaults to the stable key — the
 *  server-sourced case; pass it explicitly to model a locally-started conversation
 *  whose key never became its id. */
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
    // The parent was created by newSession(): its stable key is a client UUID and the
    // server's id — the one its subagents carry as parentId — is on `serverId`.
    // Matching parentId against the KEY makes the subagent an independent top-level
    // row, which is exactly what must never happen.
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
    // report its child count — the "▸ 1 subagent" affordance. A parent whose children
    // were never matched reports 0 and the affordance silently disappears.
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
    // activeId is the STABLE KEY (that is what the sidebar tracks selection by).
    const rows = nestSubagents([parent, child], "local-key-abc");
    expect(rows.map((r) => r.session.id)).toEqual(["local-key-abc", "srv-child"]);
    expect(rows[1].depth).toBe(1);
  });
});

describe("the parent's Subagents panel finds its children", () => {
  it("lists children of a SERVER-SOURCED parent", () => {
    const all = [s("parent"), s("c1", { parentId: "parent" }), s("c2", { parentId: "parent" }), s("other")];
    expect(subagentsOf(all, "parent").map((x) => x.id)).toEqual(["c1", "c2"]);
  });

  it("lists children of a parent the user started in this tab (local key)", () => {
    // subagentsOf is called with the store's currentId — the stable KEY. The children
    // carry the parent's SERVER id. Without resolving one to the other the panel (and
    // the whole Subagents tab, which only renders when the count is > 0) vanishes on
    // every conversation a user actually typed into.
    const all = [
      s("local-key-abc", { serverId: "srv-parent" }),
      s("srv-child", { parentId: "srv-parent" }),
      s("other"),
    ];
    expect(
      subagentsOf(all, "local-key-abc").map((x) => x.id),
      "the Subagents panel must resolve the current conversation's SERVER id",
    ).toEqual(["srv-child"]);
  });

  it("returns [] when there is no current conversation", () => {
    expect(subagentsOf([s("a")], undefined)).toEqual([]);
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

    // A single-row SSE `upsert` for an UNRELATED conversation (it was retitled). This
    // frame says nothing at all about sub-1 — absence from a one-row frame is not
    // evidence the subagent ended, and treating it as such wipes every subagent in
    // the sidebar until the next 10s poll puts them back (the flicker).
    sessionStore.mergeFromServer([{ id: "other-1", title: "Other renamed" }], {
      sourcesAuthoritative: false,
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
    // The poll is the authoritative view: the subagent finished and was end()ed
    // server-side, so its absence here DOES mean it is gone.
    sessionStore.mergeFromServer([{ id: "parent-2", title: "Parent" }]);
    const ids = sessionStore.get().sessions.map((x) => x.id);
    expect(ids).toContain("parent-2");
    expect(ids).not.toContain("sub-2");
  });

  it("APPLIES a subagent's own status upsert (running → ended)", () => {
    // A subagent's entire visible lifecycle is its status: it is spawned running and
    // then ends. Both the sidebar dot and the Subagents panel dot read it. The merge's
    // no-op guard must therefore treat a status-only change as a change — comparing a
    // subset of fields discards the update and freezes the dot at "running" forever.
    sessionStore.mergeFromServer([
      { id: "parent-3", title: "Parent" },
      { id: "sub-3", title: "research", parentId: "parent-3", status: "running" },
    ]);
    expect(sessionStore.get().sessions.find((x) => x.id === "sub-3")?.status).toBe("running");

    sessionStore.mergeFromServer([{ id: "sub-3", title: "research", parentId: "parent-3", status: "ended" }], {
      sourcesAuthoritative: false,
    });

    const sub = sessionStore.get().sessions.find((x) => x.id === "sub-3");
    expect(sub?.status, "a status-only upsert must reach the store").toBe("ended");
    expect(sessionStore.get().sessions.map((x) => x.id)).toContain("parent-3");
  });
});

describe("the whole path: a chat started in THIS TAB spawns a subagent", () => {
  it("nests the subagent and shows it in the parent's panel", async () => {
    // 1. The user clicks "New chat" and sends. The server mints the id; the row keeps
    //    its local key (swapping the key mid-run tore down the run — see sessions.ts).
    sessionStore.newSession();
    const key = sessionStore.get().currentId;
    setConversationMinter(async () => "srv-parent");
    await sessionStore.ensureCurrentCreated();
    expect(sessionStore.current().serverId).toBe("srv-parent");
    expect(key, "the stable key must NOT become the server id").not.toBe("srv-parent");

    // 2. The agent spawns a subagent. It reaches the UI as an SSE `upsert` carrying
    //    parentId = the PARENT'S SERVER ID (the only id the server knows).
    sessionStore.mergeFromServer(
      [{ id: "srv-sub", title: "research the thing", parentId: "srv-parent", status: "running" }],
      { sourcesAuthoritative: false },
    );

    // 3. The sidebar must show it as a CHILD of the parent, not as a second top-level
    //    conversation. The parent is active, so its branch is expanded.
    const rows = nestSubagents(filteredSessions(sessionStore.get()), sessionStore.get().currentId);
    const sub = rows.find((r) => r.session.id === "srv-sub");
    expect(sub, "the subagent must be listed").toBeTruthy();
    expect(sub!.depth, "a subagent must never render as an independent top-level chat").toBe(1);
    // …and it sits directly under its parent, not somewhere else in the list. (The store
    // is a module singleton, so other tests' rows are also present — assert the pair's
    // relative position rather than the whole list.)
    const ids = rows.map((r) => r.session.id);
    expect(ids[ids.indexOf("srv-sub") - 1]).toBe(key);

    // 4. The parent's Subagents panel (the sub-conversation view) must find it. This is
    //    also what gates the tab itself — a 0 count hides the tab entirely.
    expect(subagentsOf(sessionStore.get().sessions, sessionStore.get().currentId).map((x) => x.id)).toEqual([
      "srv-sub",
    ]);

    // 5. An unrelated upsert (another chat retitled) must not evict the subagent.
    sessionStore.mergeFromServer([{ id: "srv-other", title: "Unrelated" }], { sourcesAuthoritative: false });
    expect(sessionStore.get().sessions.map((x) => x.id)).toContain("srv-sub");
  });
});
