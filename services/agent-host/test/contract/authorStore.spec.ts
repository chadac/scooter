/**
 * The author store answers "who wrote this conversation's text" across its whole
 * subagent tree, each author resolved to the Scooter user it is.
 */

import { describe, it, expect } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";

import { conversationTree, createMemoryAuthorStore, createPgAuthorStore, isOwnText, steeringAuthor } from "../../src/session/authorStore.js";
import type { SessionId } from "../../src/types.js";

type Call = { sql: string; params: unknown[] };

function recordingDb(rows: unknown[] = []) {
  const calls: Call[] = [];
  const client = {
    async query(cfg: unknown, paramsIn: unknown[] = []) {
      const sql = typeof cfg === "string" ? cfg : ((cfg as { text: string }).text ?? "");
      const params = (typeof cfg === "object" && (cfg as { values?: unknown[] }).values) || paramsIn;
      calls.push({ sql, params: [...params] });
      return { rows, rowCount: rows.length };
    },
  };
  return { db: drizzle(client as never), calls };
}

describe("pg author store", () => {
  it("records each author once, with '' for an unknown one, bumping when it writes again", async () => {
    const { db, calls } = recordingDb();
    const store = createPgAuthorStore({ db, now: () => 7 });
    await store.record("c1", { kind: "identity", id: "i-1" });
    await store.record("c1", { kind: "unknown" });
    expect(calls[0].sql).toMatch(/insert into "conversation_authors".*on conflict .* do update set "last_at" = GREATEST\("conversation_authors"\."last_at" \+ 1, excluded\.last_at\)/i);
    expect(calls[0].params).toEqual(["c1", "identity", "i-1", 7, 7]);
    expect(calls[1].params).toEqual(["c1", "unknown", "", 7, 7]);
  });

  it("moves only rows not written to since they were shown into the clear history", async () => {
    const { db, calls } = recordingDb();
    const store = createPgAuthorStore({ db, now: () => 9 });
    await store.clear([{ conversationId: "c1", kind: "unknown", author: "", lastAt: 5 }], { user: "alice", via: "agent", reason: "why" });
    expect(calls[0].sql).toMatch(/delete from conversation_authors a using shown s/i);
    expect(calls[0].sql).toMatch(/a\.last_at <= s\.last_at/i);
    expect(calls[0].sql).toMatch(/insert into conversation_author_clears/i);
    expect(calls[0].params).toEqual(["c1", "unknown", "", 5, 9, "alice", "agent", "why"]);
    expect(await store.clear([], { user: "alice", via: "ui" })).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("reads the whole tree and resolves identities through their link", async () => {
    const { db, calls } = recordingDb([
      { conversation_id: "root", kind: "identity", author: "i-1", last_at: "3", user: "alice", provider: "github", handle: "al" },
      { conversation_id: "child", kind: "unknown", author: "", last_at: 4, user: null, provider: null, handle: null },
    ]);
    const authors = await createPgAuthorStore({ db }).listTree("child");
    expect(authors).toEqual([
      { conversationId: "root", kind: "identity", author: "i-1", lastAt: 3, user: "alice", provider: "github", handle: "al" },
      { conversationId: "child", kind: "unknown", author: "", lastAt: 4, user: null },
    ]);
    expect(calls[0].sql).toMatch(/with recursive up as/i);
    expect(calls[0].sql).toMatch(/c\.parent_id = down\.id/i);
    expect(calls[0].sql).toMatch(/left join identities i/i);
    expect(calls[0].params).toContain("child");
  });
});

describe("memory author store", () => {
  it("dedupes and unions the family", async () => {
    const store = createMemoryAuthorStore({ family: (id) => (id === "child" ? ["root", "child"] : [id]) });
    await store.record("root", { kind: "user", id: "alice" });
    await store.record("root", { kind: "user", id: "alice" });
    await store.record("child", { kind: "identity", id: "i-1" });
    await store.record("child", { kind: "identity", id: "i-2" });
    const byAuthor = (a: { author: string }, b: { author: string }) => a.author.localeCompare(b.author);
    expect((await store.listTree("child")).sort(byAuthor)).toMatchObject([
      { conversationId: "root", kind: "user", author: "alice", user: "alice" },
      { conversationId: "child", kind: "identity", author: "i-1", user: null },
      { conversationId: "child", kind: "identity", author: "i-2", user: null },
    ]);
  });

  it("clears a shown row unless its author wrote again", async () => {
    const store = createMemoryAuthorStore();
    await store.record("c1", { kind: "user", id: "bob" });
    await store.record("c1", { kind: "unknown" });
    const shown = await store.listTree("c1");
    await store.record("c1", { kind: "user", id: "bob" });
    expect(await store.clear(shown, { user: "alice", via: "ui" })).toBe(1);
    expect(await store.listTree("c1")).toMatchObject([{ kind: "user", author: "bob" }]);
    expect(store.clears).toMatchObject([{ kind: "unknown", user: "alice", via: "ui" }]);
  });
});

describe("conversationTree", () => {
  const convs = [
    { id: "root" as SessionId },
    { id: "a" as SessionId, parentId: "root" as SessionId },
    { id: "b" as SessionId, parentId: "a" as SessionId },
    { id: "c" as SessionId, parentId: "root" as SessionId },
    { id: "other" as SessionId },
  ];
  const sessions = { get: (id: SessionId) => convs.find((c) => c.id === id), list: () => convs };

  it("reaches the root's every descendant from any node", () => {
    expect(conversationTree(sessions, "b").sort()).toEqual(["a", "b", "c", "root"]);
    expect(conversationTree(sessions, "other")).toEqual(["other"]);
  });
});

describe("isOwnText", () => {
  it("is the owner's own prompt only", () => {
    expect(isOwnText({ kind: "user", id: "alice" }, "alice")).toBe(true);
    expect(isOwnText({ kind: "user", id: "bob" }, "alice")).toBe(false);
    expect(isOwnText({ kind: "user", id: "alice" }, undefined)).toBe(false);
    expect(isOwnText({ kind: "identity", id: "i-1" }, "alice")).toBe(false);
    expect(isOwnText({ kind: "unknown" }, "alice")).toBe(false);
  });
});

describe("steeringAuthor", () => {
  it("is nothing for the owner, the user for anyone else, and unknown when nobody signed in", () => {
    expect(steeringAuthor({ anonymous: false, id: "alice" }, "alice")).toBeUndefined();
    expect(steeringAuthor({ anonymous: false, id: "bob" }, "alice")).toEqual({ kind: "user", id: "bob" });
    expect(steeringAuthor({ anonymous: true, id: "anonymous" }, "alice")).toEqual({ kind: "unknown" });
    expect(steeringAuthor(undefined, "alice")).toEqual({ kind: "unknown" });
  });
});
