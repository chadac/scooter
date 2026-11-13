import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FolderList } from "./client.js";
import {
  allRows,
  buildFolders,
  canMoveInto,
  currentBranch,
  effectiveLifetime,
  folderOf,
  folderPath,
  folderStore,
  moveTo,
  positionBetween,
  STARRED,
  type FolderState,
} from "./folders.js";
import { conversationFor, sessionStore, setConversationMinter, type Session, type SidebarRow } from "./sessions.js";

const STARRED_FOLDER = { id: STARRED, name: "Starred", kind: "starred" as const, locked: true, position: 0, conversationLifetimeHours: 0 };
const WORK = { id: "f-work", name: "Work", kind: "user" as const, position: 1 };
const HOME = { id: "f-home", name: "Home", kind: "user" as const, position: 2 };

/** Fake server: GET /folders answers `server`; writes answer `status`. */
const stubFetch = (server: FolderList, status = 204) => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method, body: init?.body });
      const ok = method === "GET" || (status >= 200 && status < 300);
      return { ok, status: method === "GET" ? 200 : status, json: async () => server };
    }) as never,
  );
  return calls;
};

const current = (key: string): Session => sessionStore.get().sessions.find((x) => x.id === key)!;

const startedInThisBrowser = async (serverId: string): Promise<Session> => {
  setConversationMinter(async () => serverId);
  const key = sessionStore.newSession();
  await conversationFor(current(key)).ensureCreated();
  return current(key);
};

beforeEach(async () => {
  globalThis.localStorage?.clear?.();
  stubFetch({ folders: [STARRED_FOLDER, WORK, HOME], placements: {} });
  await folderStore.load();
});
afterEach(() => vi.unstubAllGlobals());

describe("buildFolders: each conversation renders in exactly one section", () => {
  const row = (s: Partial<Session> & { id: string }, depth = 0): SidebarRow => ({
    session: { title: s.id, createdAt: 1, lastActivityAt: 1, ...s },
    depth,
    childCount: 0,
  });
  const ids = (rows: SidebarRow[]) => rows.map((r) => r.session.id);
  const fs = (placements: Record<string, string>): FolderState => ({
    folders: [STARRED_FOLDER, WORK],
    placements,
    collapsed: {},
    drafts: {},
  });

  it("routes by placement, Starred first, and everything unfiled to Recent", () => {
    const { folders, recent } = buildFolders([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })], fs({ a: STARRED, b: WORK.id }));
    expect(folders.map((f) => [f.id, f.locked, ids(f.rows)])).toEqual([
      [STARRED, true, ["a"]],
      [WORK.id, false, ["b"]],
    ]);
    expect(ids(recent)).toEqual(["c"]);
  });

  it("a placement in a folder that no longer exists falls back to Recent", () => {
    const { recent } = buildFolders([row({ id: "a" })], fs({ a: "deleted" }));
    expect(ids(recent)).toEqual(["a"]);
  });

  it("renders a double-held conversation once, keyed by its server id", () => {
    const { folders, recent } = buildFolders(
      [row({ id: "local-key", serverId: "conv-1" }), row({ id: "conv-1", serverId: "conv-1" }), row({ id: "other" })],
      fs({ "conv-1": STARRED }),
    );
    expect(ids(folders[0].rows)).toEqual(["local-key"]);
    expect(ids(recent)).toEqual(["other"]);
  });

  it("subagent rows follow their parent, and a dropped duplicate parent takes them with it", () => {
    const { folders, recent } = buildFolders(
      [
        row({ id: "p-key", serverId: "p" }),
        row({ id: "kid", serverId: "kid", parentId: "p" }, 1),
        row({ id: "p", serverId: "p" }),
        row({ id: "kid-again", serverId: "kid", parentId: "p" }, 1),
        row({ id: "q" }),
        row({ id: "q-kid", parentId: "q" }, 1),
      ],
      fs({ p: WORK.id }),
    );
    expect(ids(folders[1].rows)).toEqual(["p-key", "kid"]);
    expect(ids(recent)).toEqual(["q", "q-kid"]);
  });
});

describe("moveTo files a conversation by its server id", () => {
  it("stars via PUT /conversations/<serverId>/folder and mirrors the star onto the session", async () => {
    const calls = stubFetch({ folders: [STARRED_FOLDER], placements: {} });
    const s = await startedInThisBrowser("conv-B");

    expect(await moveTo(s, STARRED)).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "PUT", body: JSON.stringify({ folderId: STARRED }) });
    expect(calls[0].url).toMatch(/\/conversations\/conv-B\/folder$/);
    expect(calls[0].url, "the local key must never reach the server").not.toContain(s.id);
    expect(current(s.id).starred).toBe(true);
    expect(folderOf(current(s.id))).toBe(STARRED);
  });

  it("filing a starred conversation elsewhere unstars it", async () => {
    stubFetch({ folders: [STARRED_FOLDER, WORK], placements: {} });
    const s = await startedInThisBrowser("conv-C");
    await moveTo(s, STARRED);
    await moveTo(current(s.id), WORK.id);
    expect(current(s.id).starred).toBeFalsy();
    expect(folderOf(current(s.id))).toBe(WORK.id);
  });

  it("a rejected write refetches, so the optimistic star doesn't stick", async () => {
    const calls = stubFetch({ folders: [STARRED_FOLDER], placements: {} }, 500);
    const s = await startedInThisBrowser("conv-E");

    expect(await moveTo(s, STARRED)).toBe(false);

    expect(calls.map((c) => c.method)).toEqual(["PUT", "GET"]);
    expect(current(s.id).starred).toBeFalsy();
  });

  it("a conversation the server never created issues no request", async () => {
    const calls = stubFetch({ folders: [STARRED_FOLDER], placements: {} });
    const key = sessionStore.newSession();
    expect(await moveTo(current(key), STARRED)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("folder edits", () => {
  it("deleting a folder returns its conversations to Recent", async () => {
    stubFetch({ folders: [STARRED_FOLDER, WORK, HOME], placements: { c1: WORK.id, c2: STARRED } });
    await folderStore.load();
    await folderStore.remove(WORK.id);
    expect(folderStore.get().placements).toEqual({ c2: STARRED });
    expect(folderStore.get().folders.map((f) => f.id)).toEqual([STARRED, HOME.id]);
  });

  it("Starred can't be renamed, deleted or moved", async () => {
    const calls = stubFetch({ folders: [STARRED_FOLDER, WORK], placements: {} });
    expect(await folderStore.rename(STARRED, "Faves")).toBe(false);
    expect(await folderStore.remove(STARRED)).toBe(false);
    expect(await folderStore.reorder(STARRED, WORK.id)).toBe(false);
    expect(await folderStore.setIcon(STARRED, "star")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("setting an icon sends it, and an empty one clears it", async () => {
    const calls = stubFetch({ folders: [STARRED_FOLDER, WORK], placements: {} });
    await folderStore.setIcon(WORK.id, " briefcase ");
    expect(folderStore.get().folders[1].icon).toBe("briefcase");
    await folderStore.setIcon(WORK.id, "");
    expect(folderStore.get().folders[1].icon).toBeUndefined();
    expect(calls.map((c) => c.body)).toEqual([JSON.stringify({ icon: "briefcase" }), JSON.stringify({ icon: "" })]);
  });

  it("reordering sends one position between the new neighbours", async () => {
    const calls = stubFetch({ folders: [STARRED_FOLDER, WORK, HOME], placements: {} });
    await folderStore.reorder(HOME.id, WORK.id);
    expect(folderStore.get().folders.map((f) => f.id)).toEqual([STARRED, HOME.id, WORK.id]);
    expect(calls[0]).toMatchObject({ method: "PATCH", body: JSON.stringify({ position: 0 }) });
  });

  it("reorders below a folder, to the top via Starred, and by nudging", async () => {
    const PLAY = { ...HOME, id: "f-play", name: "Play", position: 3 };
    const calls = stubFetch({ folders: [STARRED_FOLDER, WORK, HOME, PLAY], placements: {} });
    await folderStore.load();
    const order = () => folderStore.get().folders.map((f) => f.id);
    await folderStore.reorder(WORK.id, PLAY.id, "after");
    expect(order()).toEqual([STARRED, HOME.id, PLAY.id, WORK.id]);
    await folderStore.reorder(PLAY.id, STARRED, "after");
    expect(order()).toEqual([STARRED, PLAY.id, HOME.id, WORK.id]);
    await folderStore.nudge(HOME.id, 1);
    expect(order()).toEqual([STARRED, PLAY.id, WORK.id, HOME.id]);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(3);
  });

  it("a reorder that changes nothing sends nothing", async () => {
    const calls = stubFetch({ folders: [STARRED_FOLDER, WORK, HOME], placements: {} });
    await folderStore.load();
    expect(await folderStore.reorder(WORK.id, HOME.id)).toBe(false);
    expect(await folderStore.reorder(WORK.id, STARRED, "after")).toBe(false);
    expect(await folderStore.reorder(WORK.id, STARRED)).toBe(false);
    expect(await folderStore.nudge(WORK.id, -1)).toBe(false);
    expect(await folderStore.nudge(HOME.id, 1)).toBe(false);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("positionBetween covers both, one or no neighbours", () => {
    expect(positionBetween(1, 2)).toBe(1.5);
    expect(positionBetween(3, undefined)).toBe(4);
    expect(positionBetween(undefined, 1)).toBe(0);
    expect(positionBetween()).toBe(1);
  });

  it("a slow load never overwrites a newer one", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => (releaseSlow = r));
    const answers: FolderList[] = [
      { folders: [STARRED_FOLDER, WORK], placements: {} },
      { folders: [STARRED_FOLDER, HOME], placements: {} },
    ];
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = answers[n++];
        if (body === answers[0]) await slow;
        return { ok: true, status: 200, json: async () => body };
      }) as never,
    );
    const first = folderStore.load();
    await folderStore.load();
    releaseSlow();
    await first;
    expect(folderStore.get().folders.map((f) => f.id)).toEqual([STARRED, HOME.id]);
  });
});

describe("currentBranch: what a collapsed folder still shows", () => {
  const row = (id: string, depth = 0): SidebarRow => ({
    session: { id, title: id, createdAt: 1, lastActivityAt: 1 },
    depth,
    childCount: 0,
  });
  const rows = [row("a"), row("b"), row("b1", 1), row("b2", 1), row("b2x", 2), row("c")];
  const ids = (id: string) => currentBranch(rows, id).map((r) => r.session.id);

  it("is just the conversation when it is top level", () => expect(ids("c")).toEqual(["c"]));
  it("keeps a subagent's ancestors, not its siblings", () => expect(ids("b2x")).toEqual(["b", "b2", "b2x"]));
  it("is empty when the conversation is elsewhere", () => expect(ids("zzz")).toEqual([]));
});

describe("newIn: a conversation started inside a folder", () => {
  it("shows in the folder at once and is filed there when first sent", async () => {
    const calls = stubFetch({ folders: [STARRED_FOLDER, WORK], placements: {} });
    setConversationMinter(async () => "srv-new");
    const key = folderStore.newIn(WORK.id);
    expect(sessionStore.get().currentId).toBe(key);
    expect(folderOf(current(key))).toBe(WORK.id);
    expect(calls).toHaveLength(0);

    await conversationFor(current(key)).ensureCreated();
    expect(calls).toEqual([expect.objectContaining({ method: "PUT", url: expect.stringContaining("/conversations/srv-new/folder") })]);
    expect(folderStore.get().placements).toEqual({ "srv-new": WORK.id });
    expect(folderStore.get().drafts).toEqual({});
  });

  it("is filed before the create resolves, so the first send's run already sees the folder (#1361)", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let releasePut!: () => void;
    const putDone = new Promise<void>((r) => (releasePut = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? "GET";
        calls.push({ url: String(url), method });
        if (method === "PUT") await putDone;
        return { ok: true, status: method === "GET" ? 200 : 204, json: async () => ({ folders: [STARRED_FOLDER, WORK], placements: {} }) };
      }) as never,
    );
    setConversationMinter(async () => "srv-first");
    const key = folderStore.newIn(WORK.id);

    let created = false;
    const creating = conversationFor(current(key)).ensureCreated().then((id) => {
      created = true;
      return id;
    });
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    // Shown in the folder throughout, never bouncing through Recent.
    expect(folderOf(current(key))).toBe(WORK.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(created, "the send must wait for the folder write").toBe(false);

    releasePut();
    expect(await creating).toBe("srv-first");
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      expect.objectContaining({ url: expect.stringContaining("/conversations/srv-first/folder") }),
    ]);
    expect(folderOf(current(key))).toBe(WORK.id);
    expect(folderStore.get().drafts).toEqual({});
  });

  it("a failed folder write still creates the conversation, and filing retries once it has an id", async () => {
    const calls = stubFetch({ folders: [STARRED_FOLDER, WORK], placements: {} }, 500);
    setConversationMinter(async () => "srv-retry");
    const key = folderStore.newIn(WORK.id);
    expect(await conversationFor(current(key)).ensureCreated()).toBe("srv-retry");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("the main New conversation button takes a reused draft back out", () => {
    const key = folderStore.newIn(WORK.id);
    expect(folderStore.newIn(null)).toBe(key);
    expect(folderOf(current(key))).toBeNull();
  });
});

describe("nested folders", () => {
  // Work > Scooter > UI, plus Home at the top.
  const SCOOTER = { id: "f-scooter", name: "Scooter", kind: "user" as const, position: 1, parentId: WORK.id };
  const UI = { id: "f-ui", name: "UI", kind: "user" as const, position: 1, parentId: SCOOTER.id };
  const DESIGN = { id: "f-design", name: "Design", kind: "user" as const, locked: true, position: 0, conversationLifetimeHours: 0 };
  const tree = [STARRED_FOLDER, DESIGN, WORK, HOME, SCOOTER, UI];
  const load = async (placements: Record<string, string> = {}) => {
    const calls = stubFetch({ folders: tree, placements });
    await folderStore.load();
    return calls;
  };

  it("buildFolders nests sections and counts a subtree", () => {
    const row = (id: string): SidebarRow => ({ session: { id, title: id, createdAt: 1, lastActivityAt: 1 }, depth: 0, childCount: 0 });
    const fs: FolderState = { folders: tree, placements: { a: WORK.id, b: UI.id, c: DESIGN.id }, collapsed: {}, drafts: {} };
    const { folders } = buildFolders([row("a"), row("b"), row("c")], fs);
    expect(folders.map((f) => [f.id, f.locked])).toEqual([
      [STARRED, true],
      [DESIGN.id, true],
      [WORK.id, false],
      [HOME.id, false],
    ]);
    const work = folders[2];
    expect(work.children.map((c) => c.id)).toEqual([SCOOTER.id]);
    expect(work.children[0].children[0]).toMatchObject({ id: UI.id, depth: 3 });
    expect(allRows(work).map((r) => r.session.id)).toEqual(["a", "b"]);
    expect(folders[1].rows.map((r) => r.session.id)).toEqual(["c"]);
  });

  it("refuses moves past three levels or into the folder's own subtree", async () => {
    await load();
    expect(canMoveInto(HOME.id, UI.id)).toBe(false); // 4th level
    expect(canMoveInto(HOME.id, SCOOTER.id)).toBe(true);
    expect(canMoveInto(WORK.id, HOME.id)).toBe(false); // its 3 levels would become 4
    expect(canMoveInto(WORK.id, UI.id)).toBe(false); // own subtree
    expect(canMoveInto(HOME.id, DESIGN.id)).toBe(false); // locked folders take no subfolders
    expect(canMoveInto(DESIGN.id, null)).toBe(false);
    expect(await folderStore.reorder(HOME.id, UI.id, "into")).toBe(false);
    expect(await folderStore.create("Too deep", UI.id)).toBeNull();
  });

  it("drops into a folder, beside a subfolder, and back to the top", async () => {
    const calls = await load();
    await folderStore.reorder(HOME.id, SCOOTER.id, "into");
    expect(folderStore.get().folders.find((f) => f.id === HOME.id)?.parentId).toBe(SCOOTER.id);
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ position: 2, parentId: SCOOTER.id });
    await folderStore.reorder(HOME.id, SCOOTER.id, "before");
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ position: 0, parentId: WORK.id });
    await folderStore.moveInto(HOME.id, null);
    expect(folderStore.get().folders.find((f) => f.id === HOME.id)?.parentId).toBeUndefined();
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ parentId: "" });
    expect(folderPath(UI.id)).toBe("Work / Scooter / UI");
  });

  it("deleting lifts contents a level, or drops the subtree", async () => {
    let calls = await load({ c1: SCOOTER.id, c2: UI.id });
    await folderStore.remove(SCOOTER.id);
    let { folders, placements } = folderStore.get();
    expect(folders.find((f) => f.id === UI.id)?.parentId).toBe(WORK.id);
    expect(placements).toEqual({ c1: WORK.id, c2: UI.id });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
    expect(calls.at(-1)!.url).not.toContain("subfolders");

    calls = await load({ c1: SCOOTER.id, c2: UI.id, c3: HOME.id });
    await folderStore.remove(WORK.id, true);
    ({ folders, placements } = folderStore.get());
    expect(folders.map((f) => f.id)).toEqual([STARRED, DESIGN.id, HOME.id]);
    expect(placements).toEqual({ c3: HOME.id });
    expect(calls.at(-1)!.url).toContain("?subfolders=delete");
  });

  it("a lifetime is set, cleared, and inherited from the nearest folder", async () => {
    const calls = await load();
    await folderStore.setLifetime(WORK.id, 24);
    expect(effectiveLifetime(UI.id)).toMatchObject({ hours: 24, from: { id: WORK.id } });
    await folderStore.setLifetime(SCOOTER.id, 0);
    expect(effectiveLifetime(UI.id)).toMatchObject({ hours: 0, from: { id: SCOOTER.id } });
    await folderStore.setLifetime(SCOOTER.id, null);
    expect(effectiveLifetime(UI.id)?.hours).toBe(24);
    expect(effectiveLifetime(HOME.id)).toBeUndefined();
    expect(calls.map((c) => c.body).filter(Boolean)).toEqual([
      JSON.stringify({ conversationLifetimeHours: 24 }),
      JSON.stringify({ conversationLifetimeHours: 0 }),
      JSON.stringify({ conversationLifetimeHours: null }),
    ]);
    expect(await folderStore.setLifetime(DESIGN.id, 24)).toBe(false);
  });

  it("locked folders can't be renamed, moved or deleted", async () => {
    const calls = await load();
    expect(await folderStore.rename(DESIGN.id, "x")).toBe(false);
    expect(await folderStore.remove(DESIGN.id)).toBe(false);
    expect(await folderStore.reorder(DESIGN.id, WORK.id)).toBe(false);
    expect(await folderStore.moveInto(DESIGN.id, WORK.id)).toBe(false);
    expect(calls).toHaveLength(1); // just the load
    // Others still drop beside it.
    await folderStore.reorder(HOME.id, DESIGN.id, "after");
    expect(folderStore.get().folders.filter((f) => f.kind === "user" && !f.parentId).map((f) => f.id)).toEqual([DESIGN.id, HOME.id, WORK.id]);
  });
});
