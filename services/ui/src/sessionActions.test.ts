/**
 * The sidebar's row actions address the server by the server's id.
 *
 * A conversation started in this browser keeps its local key as `Session.id` for
 * life (adoptServerId records the server id alongside it), so rename and
 * delete must send the server id to the API while the store stays keyed locally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  conversationFor,
  sessionStore,
  setConversationMinter,
  type Session,
} from "./sessions.js";
import { commitRename, isServerBacked, removeSession } from "./sessionActions.js";

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

/** A conversation as it exists after being started here: a local key plus the server id adopted on first send. */
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
    expect(s.id).not.toBe(s.serverId);
    expect(isServerBacked(s)).toBe(true);
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

describe("a conversation the server has never created", () => {
  it("is not server-backed, so the star control is disabled rather than lying", () => {
    const key = sessionStore.newSession();
    expect(isServerBacked(current(key))).toBe(false);
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

describe("deleting a draft while its first send is creating it", () => {
  it("deletes the conversation server-side once its id arrives, rather than orphaning it", async () => {
    const calls = stubFetch(204);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setConversationMinter(async () => {
      await gate;
      return "conv-late";
    });
    const key = sessionStore.newSession();
    const create = conversationFor(current(key)).ensureCreated();

    const removing = removeSession(current(key));
    expect(sessionStore.get().sessions.some((x) => x.id === key)).toBe(false);
    release();
    await create;
    await removing;

    expect(calls).toEqual([expect.objectContaining({ method: "DELETE", url: expect.stringMatching(/\/conversations\/conv-late$/) })]);
  });
});
