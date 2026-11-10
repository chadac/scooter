/** A conversation's family: root lookup, ordering, activity and who may start a session. */

import { describe, it, expect } from "vitest";

import { canStartSession, familyActivity, familyOf, rootOf } from "./family.js";
import { stepMember } from "./ChatSwitcher.js";
import type { Session } from "./sessions.js";

const s = (id: string, over: Partial<Session> = {}): Session => ({ id, title: id, createdAt: 1, lastActivityAt: 1, ...over });

const all = [
  s("local-key", { serverId: "p", status: "running", owner: "alice" }),
  s("sub", { parentId: "p", kind: "subagent", createdAt: 2 }),
  s("ses-b", { parentId: "p", kind: "session", createdAt: 5 }),
  s("ses-a", { parentId: "p", kind: "session", createdAt: 3 }),
  s("grandchild", { parentId: "ses-a", kind: "subagent", createdAt: 4 }),
  s("other"),
];

describe("rootOf", () => {
  it("walks up by server id from any member, and finds a root by its local key", () => {
    expect(rootOf(all, "grandchild")?.id).toBe("local-key");
    expect(rootOf(all, "local-key")?.id).toBe("local-key");
    expect(rootOf(all, "p")?.id).toBe("local-key");
    expect(rootOf(all, undefined)).toBeUndefined();
  });

  it("stops at a missing parent and survives a cycle", () => {
    expect(rootOf([s("orphan", { parentId: "gone" })], "orphan")?.id).toBe("orphan");
    expect(rootOf([s("a", { parentId: "b" }), s("b", { parentId: "a" })], "a")).toBeDefined();
  });
});

describe("familyOf", () => {
  it("is the root, then sessions oldest first, then subagents, each followed by its own children", () => {
    expect(familyOf(all, "sub").map((m) => [m.session.id, m.depth])).toEqual([
      ["local-key", 0],
      ["ses-a", 1],
      ["grandchild", 2],
      ["ses-b", 1],
      ["sub", 1],
    ]);
  });

  it("never lists conversations outside the family", () => {
    expect(familyOf(all, "other").map((m) => m.session.id)).toEqual(["other"]);
    expect(familyOf(all, "unknown")).toEqual([]);
  });
});

describe("familyActivity", () => {
  it("counts members mid-turn and members waiting on the user, once each", () => {
    const members = familyOf(
      [
        s("p", { runStartedAt: 1 }),
        s("c1", { parentId: "p", runStartedAt: 1, awaitingInputAt: 2 }),
        s("c2", { parentId: "p", runStartedAt: 1, status: "suspended" }),
      ],
      "p",
    );
    expect(familyActivity(members)).toEqual({ running: 1, awaiting: 1 });
  });
});

describe("canStartSession", () => {
  const alice = { id: "alice", anonymous: false };
  it("lets the owner start one in a running top-level conversation", () => {
    expect(canStartSession(all[0], alice)).toBe(true);
  });

  it("refuses a child, an unsent draft, a suspended sandbox and someone else's conversation", () => {
    expect(canStartSession(all[1], alice)).toBe(false);
    expect(canStartSession(s("draft", { status: "running" }), alice)).toBe(false);
    expect(canStartSession({ ...all[0], status: "suspended" }, alice)).toBe(false);
    expect(canStartSession(all[0], { id: "bob", anonymous: false })).toBe(false);
    expect(canStartSession(undefined, alice)).toBe(false);
  });
});

describe("stepMember", () => {
  const members = familyOf(all, "p");
  it("cycles both ways and wraps", () => {
    expect(stepMember(members, "local-key", 1)).toBe("ses-a");
    expect(stepMember(members, "local-key", -1)).toBe("sub");
    expect(stepMember(members, "sub", 1)).toBe("local-key");
  });
});
