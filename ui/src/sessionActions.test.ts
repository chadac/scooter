/**
 * UI unit test — the sidebar's row actions address the SERVER by the server's id.
 *
 * The regression: a conversation started in this browser keeps its LOCAL key as
 * `Session.id` for life (adoptServerId records the server id alongside it and never
 * rewrites the key). Star / rename / delete passed that key to the API, so every one
 * of them 404'd — 34 of 48 star writes in a week of production logs. The star lit up
 * optimistically and the next merge poll dropped it, which read as "favoriting doesn't
 * work"; delete leaked the sandbox. Why: PR #501.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  conversationFor,
  sessionStore,
  setConversationMinter,
  type Session,
} from "./sessions.js";
import { commitRename, isServerBacked, removeSession, toggleStar } from "./sessionActions.js";

/** Fake fetch: records every call and answers with `status`. */
const stubFetch = (status = 200) => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ id: "conv-server", starred: true, title: "t" }),
      };
    }) as never,
  );
  return calls;
};

const current = (key: string): Session =>
  sessionStore.get().sessions.find((x) => x.id === key)!;

/** A conversation as it exists after being started HERE: a local key, plus the server
 *  id adopted on first send. This is the shape the bug lived in. */
const startedInThisBrowser = async (serverId: string): Promise<Session> => {
  setConversationMinter(async () => serverId);
  const key = sessionStore.newSession();
  await conversationFor(current(key)).ensureCreated();
  return current(key);
};

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  sessionStore.clearEditing();
});
afterEach(() => vi.unstubAllGlobals());

describe("sidebar actions address the server by serverId, not the local key", () => {
  it("a conversation started here has a local key that is NOT its server id", async () => {
    const s = await startedInThisBrowser("conv-A");
    expect(s.serverId).toBe("conv-A");
    expect(s.id).not.toBe(s.serverId); // the premise of the whole bug
    expect(isServerBacked(s)).toBe(true);
  });

  it("STAR patches /conversations/<serverId>/starred", async () => {
    const calls = stubFetch();
    const s = await startedInThisBrowser("conv-B");

    await toggleStar(s);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/conversations/conv-B/starred");
    expect(calls[0].url, "the local key must never reach the server").not.toContain(s.id);
    expect(calls[0].body).toBe(JSON.stringify({ starred: true }));
    // …and the STORE is still keyed by the local key.
    expect(current(s.id).starred).toBe(true);
  });

  it("RENAME patches /conversations/<serverId>/title", async () => {
    const calls = stubFetch();
    const s = await startedInThisBrowser("conv-C");

    await commitRename(s, "  renamed  ");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/conversations/conv-C/title");
    expect(calls[0].url).not.toContain(s.id);
    expect(calls[0].body).toBe(JSON.stringify({ title: "renamed" }));
    expect(current(s.id).title).toBe("renamed");
    expect(current(s.id).userTitled).toBe(true);
  });

  it("DELETE deletes /conversations/<serverId> — an unaddressable delete leaks the sandbox", async () => {
    const calls = stubFetch(204);
    const s = await startedInThisBrowser("conv-D");

    await removeSession(s);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toMatch(/\/conversations\/conv-D$/);
    expect(calls[0].url).not.toContain(s.id);
    expect(sessionStore.get().sessions.some((x) => x.id === s.id)).toBe(false);
  });
});

describe("a failed star write is rolled back", () => {
  it("reverts the optimistic star when the server rejects it", async () => {
    stubFetch(404);
    const s = await startedInThisBrowser("conv-E");

    await toggleStar(s);

    // Not left lit for the 10s until the merge poll silently drops it.
    expect(current(s.id).starred).toBe(false);
  });

  it("does NOT clobber a choice the user made while the write was in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return { ok: false, status: 500, json: async () => ({}) };
      }) as never,
    );
    const s = await startedInThisBrowser("conv-F");

    const inFlight = toggleStar(s); // -> starred true, write pending
    sessionStore.setStarred(s.id, false); // the user unstars while it's in flight
    release();
    await inFlight;

    // The rollback fires only while the row still holds the value WE set. Here the
    // user has moved on, so their choice stands rather than being flipped back.
    expect(current(s.id).starred).toBe(false);
  });
});

describe("a conversation the server has never created", () => {
  it("is not server-backed, so the star control is disabled rather than lying", () => {
    const key = sessionStore.newSession();
    expect(isServerBacked(current(key))).toBe(false);
  });

  it("stars nothing and issues no request", async () => {
    const calls = stubFetch();
    const key = sessionStore.newSession();

    await toggleStar(current(key));

    expect(calls).toHaveLength(0);
    expect(current(key).starred).toBeFalsy();
  });

  it("renames LOCALLY without a request (there is no row to write yet)", async () => {
    const calls = stubFetch();
    const key = sessionStore.newSession();

    await commitRename(current(key), "local only");

    expect(calls).toHaveLength(0);
    expect(current(key).title).toBe("local only");
  });

  it("deletes locally without a request", async () => {
    const calls = stubFetch();
    const key = sessionStore.newSession();

    await removeSession(current(key));

    expect(calls).toHaveLength(0);
    expect(sessionStore.get().sessions.some((x) => x.id === key)).toBe(false);
  });
});
