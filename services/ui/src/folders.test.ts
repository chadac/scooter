import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FolderList } from "./client.js";
import { buildFolders, folderOf, folderStore, moveTo, positionBetween, STARRED, type FolderState } from "./folders.js";
import { conversationFor, sessionStore, setConversationMinter, type Session, type SidebarRow } from "./sessions.js";

const STARRED_FOLDER = { id: STARRED, name: "Starred", kind: "starred" as const, position: 0 };
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
  });

  it("routes by placement, Starred first, and everything unfiled to Recent", () => {
    const { folders, recent } = buildFolders([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })], fs({ a: STARRED, b: WORK.id }));
    expect(folders.map((f) => [f.id, f.builtin, ids(f.rows)])).toEqual([
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
    expect(calls).toHaveLength(0);
  });

  it("reordering sends one position between the new neighbours", async () => {
    const calls = stubFetch({ folders: [STARRED_FOLDER, WORK, HOME], placements: {} });
    await folderStore.reorder(HOME.id, WORK.id);
    expect(folderStore.get().folders.map((f) => f.id)).toEqual([STARRED, HOME.id, WORK.id]);
    expect(calls[0]).toMatchObject({ method: "PATCH", body: JSON.stringify({ position: 0 }) });
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
