/**
 * How a taint reads to the owner and the agent, and what an untaint card recorded.
 */

import { describe, it, expect } from "vitest";

import type { AguiEvent } from "../../src/bridge.js";
import { answerUntaint, describeTaint, taintingAuthors, untaintRequestOf, type UntaintAnswerDeps } from "../../src/session/taint.js";
import { createMemoryAuthorStore } from "../../src/session/authorStore.js";
import type { ResolvedAuthor } from "../../src/session/authorStore.js";

const row = (over: Partial<ResolvedAuthor>): ResolvedAuthor => ({
  conversationId: "c1", kind: "unknown", author: "", user: null, lastAt: 1, ...over,
});

describe("describeTaint", () => {
  it("lists each distinct author once", () => {
    const authors = [
      row({ kind: "identity", author: "i-1", provider: "github", handle: "someone" }),
      row({ kind: "user", author: "alice@example.com", user: "alice@example.com" }),
      row({}),
      row({ conversationId: "child" }),
    ];
    expect(describeTaint(authors)).toBe("@someone (github), user alice@example.com, and unattributed text");
    expect(describeTaint([row({ kind: "identity", author: "i-9" })])).toBe("account i-9");
  });
});

describe("taintingAuthors", () => {
  it("drops the owner's own linked accounts", () => {
    const mine = row({ kind: "identity", author: "i-1", user: "alice" });
    const theirs = row({ kind: "identity", author: "i-2", user: "bob" });
    expect(taintingAuthors([mine, theirs], "alice")).toEqual([theirs]);
    expect(taintingAuthors([mine], undefined)).toEqual([mine]);
  });
});

describe("untaintRequestOf", () => {
  const raised = (id: string, untaint: unknown): AguiEvent =>
    ({
      type: "RUN_FINISHED",
      threadId: "c1",
      runId: `ext-${id}`,
      outcome: { type: "interrupt", interrupts: [{ id, reason: "confirmation", message: "m", metadata: { contrib: "untaint", untaint } }] },
    }) as AguiEvent;

  it("reads what the card showed, even once answered", () => {
    const authors = [{ conversationId: "c1", kind: "unknown", author: "", lastAt: 4 }];
    const events = [raised("u1", { authors, reason: "push" }), { type: "PERMISSION_RESOLVED", toolCallId: "u1", optionId: "approve" } as AguiEvent];
    expect(untaintRequestOf(events, "u1")).toEqual({ authors, reason: "push" });
  });

  it("is undefined for another card or a malformed one", () => {
    expect(untaintRequestOf([raised("u1", { authors: [], reason: "x" })], "u2")).toBeUndefined();
    expect(untaintRequestOf([raised("u1", { authors: [{ kind: "nope" }], reason: "x" })], "u1")).toBeUndefined();
  });
});

describe("answerUntaint", () => {
  const shownUnknown = { conversationId: "c1", kind: "unknown" as const, author: "", lastAt: 1 };
  const card = {
    type: "RUN_FINISHED",
    threadId: "c1",
    runId: "ext-u1",
    outcome: {
      type: "interrupt",
      interrupts: [{ id: "u1", reason: "confirmation", message: "m", metadata: { untaint: { authors: [shownUnknown], reason: "push" } } }],
    },
  } as AguiEvent;

  async function setup(visibility = "private") {
    const store = createMemoryAuthorStore();
    await store.record("c1", { kind: "unknown" });
    const told: string[] = [];
    const deps: UntaintAnswerDeps = {
      access: async () => ({ owner: "alice", visibility }),
      events: async () => [card],
      store,
      tell: (_id, text) => told.push(text),
    };
    return { store, told, deps };
  }

  it("clears what the card showed when the owner approves, and tells the agent", async () => {
    const { store, told, deps } = await setup();
    await answerUntaint(deps, "c1", "u1", "approve", { id: "alice" });
    expect(await store.listTree("c1")).toEqual([]);
    expect(store.clears).toMatchObject([{ user: "alice", via: "agent", reason: "push" }]);
    expect(told[0]).toMatch(/cleared this conversation's taint/);
  });

  it("refuses anyone but the owner, and a shared conversation", async () => {
    const { store, deps } = await setup();
    await expect(answerUntaint(deps, "c1", "u1", "approve", { id: "bob" })).rejects.toThrow(/only the conversation's owner/);
    const shared = await setup("shared");
    await expect(answerUntaint(shared.deps, "c1", "u1", "approve", { id: "alice" })).rejects.toThrow(/private/);
    expect([...(await store.listTree("c1")), ...(await shared.store.listTree("c1"))]).toHaveLength(2);
  });

  it("leaves the taint on a denial and says so", async () => {
    const { store, told, deps } = await setup();
    await answerUntaint(deps, "c1", "u1", "deny", { id: "alice" });
    expect(await store.listTree("c1")).toHaveLength(1);
    expect(told[0]).toMatch(/declined/);
  });
});
