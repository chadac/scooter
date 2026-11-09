/**
 * The SubagentManager implementation over fake sessions and store, covering the
 * send/recentTurns/searchHistory logic the handler tests do not.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createSubagentManager,
  type SubagentConversation,
  type SubagentSessions,
  type SubagentStore,
} from "../../src/session/subagentManager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SessionId } from "../../src/types.js";

const PARENT = "parent-1" as SessionId;

/** A fake child whose run state is set by `running`. */
function child(id: string, parentId: string | undefined, running: boolean, ended = false): SubagentConversation {
  return {
    id,
    parentId,
    ...(parentId ? { kind: "subagent" as const } : {}),
    title: `child ${id}`,
    status: ended ? "ended" : undefined,
    bridge: {
      queueState: () => ({ running }),
      cancel: vi.fn(),
    },
  };
}

/** Fake sessions and store over a fixed set of children and per-id event logs. */
function fakes(children: SubagentConversation[], logs: Record<string, AguiEvent[]> = {}) {
  const byId = new Map(children.map((c) => [c.id, c]));
  const prompt = vi.fn(async () => {});
  const sessions: SubagentSessions = {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    spawnChild: vi.fn(async (_p, threadId, args) => ({ id: threadId, title: args.title })),
    prompt,
  };
  const store: SubagentStore = {
    async *readEvents(id) {
      for (const e of logs[id] ?? []) yield e;
    },
  };
  return { sessions, store, prompt, mgr: createSubagentManager(sessions, store) };
}

const ev = (e: Record<string, unknown>) => e as unknown as AguiEvent;

describe("createSubagentManager", () => {
  describe("send (clarify a running child)", () => {
    it("SENDS a priority-interrupt clarification to a RUNNING child (the success path)", async () => {
      const { mgr, prompt } = fakes([child("sub-a", PARENT, /* running */ true)]);
      const res = await mgr.send(PARENT, "sub-a", "focus on login()");
      expect(res).toEqual({ outcome: "sent" });
      // It prompted the child at PRIORITY_INTERRUPT with a source.
      expect(prompt).toHaveBeenCalledTimes(1);
      const [id, text, , priority, interrupt, , , source] = prompt.mock.calls[0];
      expect(id).toBe("sub-a");
      expect(text).toContain("focus on login()");
      expect(priority).toBe(10);
      expect(interrupt).toBe("thinking");
      expect(source).toBe("parent-clarification");
    });

    it("FAILS with not-running for an idle child (nothing to clarify)", async () => {
      const { mgr, prompt } = fakes([child("sub-a", PARENT, /* running */ false)]);
      expect(await mgr.send(PARENT, "sub-a", "hi")).toEqual({ outcome: "not-running" });
      expect(prompt).not.toHaveBeenCalled();
    });

    it("FAILS with not-running for an ended child", async () => {
      const { mgr } = fakes([child("sub-a", PARENT, false, /* ended */ true)]);
      expect(await mgr.send(PARENT, "sub-a", "hi")).toEqual({ outcome: "not-running" });
    });

    it("returns unknown for a NON-child (scoping) — a running convo of ANOTHER parent", async () => {
      const { mgr, prompt } = fakes([child("sub-x", "other-parent", true)]);
      expect(await mgr.send(PARENT, "sub-x", "hi")).toEqual({ outcome: "unknown" });
      expect(prompt).not.toHaveBeenCalled();
    });

    it("returns unknown for an unknown id", async () => {
      const { mgr } = fakes([child("sub-a", PARENT, true)]);
      expect(await mgr.send(PARENT, "nope", "hi")).toEqual({ outcome: "unknown" });
    });
  });

  describe("recentTurns / searchHistory", () => {
    const log = [
      ev({ type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "find the auth bug" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "u1" }),
      ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" }),
      ev({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"command":"grep -r auth"}' }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "the bug is in login()" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
    ];

    it("recentTurns folds the child's log into turns (text + tool summary), scoped", async () => {
      const { mgr } = fakes([child("sub-a", PARENT, true)], { "sub-a": log });
      const turns = await mgr.recentTurns(PARENT, "sub-a", 10);
      expect(turns?.map((t) => t.role)).toEqual(["user", "tool", "assistant"]);
      expect(turns?.find((t) => t.role === "tool")?.text).toContain("grep -r auth");
    });

    it("recentTurns keeps only the last n turns", async () => {
      const { mgr } = fakes([child("sub-a", PARENT, true)], { "sub-a": log });
      const turns = await mgr.recentTurns(PARENT, "sub-a", 1);
      expect(turns).toHaveLength(1);
      expect(turns?.[0]).toMatchObject({ role: "assistant" });
    });

    it("recentTurns is undefined for a non-child (scoping)", async () => {
      const { mgr } = fakes([child("sub-x", "other", true)], { "sub-x": log });
      expect(await mgr.recentTurns(PARENT, "sub-x", 5)).toBeUndefined();
    });

    it("searchHistory returns only matching turns (case-insensitive)", async () => {
      const { mgr } = fakes([child("sub-a", PARENT, true)], { "sub-a": log });
      const hits = await mgr.searchHistory(PARENT, "sub-a", "LOGIN");
      expect(hits).toHaveLength(1);
      expect(hits?.[0].text).toContain("login()");
    });

    it("searchHistory matches tool summaries too, and returns [] on no match", async () => {
      const { mgr } = fakes([child("sub-a", PARENT, true)], { "sub-a": log });
      expect((await mgr.searchHistory(PARENT, "sub-a", "grep"))?.length).toBe(1);
      expect(await mgr.searchHistory(PARENT, "sub-a", "zzz")).toEqual([]);
    });
  });

  describe("list / check status", () => {
    it("list reports each child's status; check is scoped to own children", async () => {
      const { mgr } = fakes([
        child("sub-a", PARENT, true),
        child("sub-b", PARENT, false),
        child("sub-x", "other", true),
      ]);
      const listed = await mgr.list(PARENT);
      expect(listed.map((c) => c.id).sort()).toEqual(["sub-a", "sub-b"]);
      expect(listed.find((c) => c.id === "sub-a")?.status).toBe("running");
      expect(listed.find((c) => c.id === "sub-b")?.status).toBe("idle");
      expect(await mgr.check(PARENT, "sub-x")).toBeUndefined();
    });
  });
});

describe("spawn limits (the 2026-10-19 subagent storm)", () => {
  /** A live child that is running, queued, or not yet wired. */
  const busy = (id: string, parentId: string, q: { running?: boolean; queued?: number } | "unwired" = { running: true }) =>
    ({
      id,
      parentId,
      kind: "subagent",
      status: "running",
      bridge: q === "unwired" ? undefined : { queueState: () => ({ running: q.running ?? false, queued: q.queued ?? 0 }), cancel: vi.fn() },
    }) as SubagentConversation;

  const top = (id: string) => ({ id, status: "running" }) as SubagentConversation;

  const mgrOver = (convs: SubagentConversation[], limits = { maxDepth: 1, maxRunningPerParent: 2, maxRunningPerHost: 3 }) => {
    const byId = new Map(convs.map((c) => [c.id, c]));
    const sessions: SubagentSessions = {
      get: (id) => byId.get(id),
      list: () => [...byId.values()],
      spawnChild: vi.fn(async (parentId, threadId) => {
        const c = busy(threadId, parentId, { queued: 1 });
        byId.set(threadId, c);
        return { id: threadId };
      }),
      prompt: vi.fn(async () => {}),
    };
    const store: SubagentStore = { async *readEvents() {} };
    return { sessions, mgr: createSubagentManager(sessions, store, undefined, limits) };
  };

  it("THE BUG: a subagent cannot spawn its own subagent at the default depth @proves", async () => {
    const { mgr, sessions } = mgrOver([top("root"), busy("kid", "root")]);
    await expect(mgr.spawn("kid" as SessionId, { prompt: "x" })).rejects.toThrow(/nest at most 1/);
    expect(sessions.spawnChild).not.toHaveBeenCalled();
  });

  it("a top-level conversation can spawn", async () => {
    const { mgr } = mgrOver([top("root")]);
    await expect(mgr.spawn("root" as SessionId, { prompt: "x" })).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("maxDepth 2 allows one nested level, not two", async () => {
    const limits = { maxDepth: 2, maxRunningPerParent: 9, maxRunningPerHost: 9 };
    const { mgr } = mgrOver([top("root"), busy("kid", "root"), busy("grandkid", "kid")], limits);
    await expect(mgr.spawn("kid" as SessionId, { prompt: "x" })).resolves.toBeDefined();
    await expect(mgr.spawn("grandkid" as SessionId, { prompt: "x" })).rejects.toThrow(/nest at most 2/);
  });

  it("refuses past the per-parent cap, counting queued and unwired children", async () => {
    const { mgr } = mgrOver([top("root"), busy("a", "root", { queued: 1 }), busy("b", "root", "unwired")]);
    await expect(mgr.spawn("root" as SessionId, { prompt: "x" })).rejects.toThrow(/2 running subagents \(limit 2\)/);
  });

  it("idle and ended children free their slot", async () => {
    const idle = busy("a", "root", { running: false, queued: 0 });
    const ended = { ...busy("b", "root"), status: "ended" } as SubagentConversation;
    const { mgr } = mgrOver([top("root"), idle, ended]);
    await expect(mgr.spawn("root" as SessionId, { prompt: "x" })).resolves.toBeDefined();
  });

  it("refuses past the per-host cap across parents", async () => {
    const { mgr } = mgrOver([top("p1"), top("p2"), top("p3"), busy("a", "p1"), busy("b", "p2"), busy("c", "p3")]);
    await expect(mgr.spawn("p1" as SessionId, { prompt: "x" })).rejects.toThrow(/this host is running 3 subagents/);
  });

  it("THE BUG: a parallel burst cannot overshoot the cap while spawns are in flight @proves", async () => {
    const { mgr, sessions } = mgrOver([top("root")], { maxDepth: 1, maxRunningPerParent: 2, maxRunningPerHost: 9 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => mgr.spawn("root" as SessionId, { prompt: "x" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(sessions.spawnChild).toHaveBeenCalledTimes(2);
  });
});

describe("sessions (children a person drives, e.g. VS Code chats)", () => {
  const top = (id: string) => ({ id, status: "running" }) as SubagentConversation;
  const kid = (id: string, parentId: string, kind: "subagent" | "session" = "subagent", running = false) =>
    ({
      id,
      parentId,
      kind,
      title: id,
      status: "running",
      bridge: { queueState: () => ({ running, queued: 0 }), cancel: vi.fn() },
    }) as SubagentConversation;

  const mgrOver = (convs: SubagentConversation[], limits = { maxDepth: 1, maxRunningPerParent: 2, maxRunningPerHost: 9 }) => {
    const byId = new Map(convs.map((c) => [c.id, c]));
    const sessions: SubagentSessions = {
      get: (id) => byId.get(id),
      list: () => [...byId.values()],
      spawnChild: vi.fn(async (_p, threadId, args) => ({ id: threadId, title: args.title })),
      prompt: vi.fn(async () => {}),
    };
    const createChild = vi.fn(async () => ({ id: "minted" }));
    const store: SubagentStore = { async *readEvents() {} };
    return { sessions, createChild, mgr: createSubagentManager(sessions, store, createChild, limits) };
  };

  it("creates a session with no prompt and asks the router for kind session", async () => {
    const { mgr, sessions, createChild } = mgrOver([top("root")]);
    await expect(mgr.spawn("root" as SessionId, { kind: "session", title: "VS Code" })).resolves.toEqual({ id: "minted", title: "VS Code" });
    expect(createChild).toHaveBeenCalledWith("root", { title: "VS Code", model: undefined, kind: "session" });
    expect(sessions.spawnChild).toHaveBeenCalledWith("root", "minted", { kind: "session", title: "VS Code" });
  });

  it("a session is depth 0, so it may spawn subagents at the default depth", async () => {
    const { mgr } = mgrOver([top("root"), kid("ses", "root", "session")]);
    await expect(mgr.spawn("ses" as SessionId, { prompt: "x" })).resolves.toBeDefined();
  });

  it("a session's subagent still cannot nest further", async () => {
    const { mgr } = mgrOver([top("root"), kid("ses", "root", "session"), kid("sub", "ses")]);
    await expect(mgr.spawn("sub" as SessionId, { prompt: "x" })).rejects.toThrow(/nest at most 1/);
  });

  it("a busy session counts against the per-parent cap", async () => {
    const { mgr } = mgrOver([top("root"), kid("ses", "root", "session", true), kid("sub", "root", undefined, true)]);
    await expect(mgr.spawn("root" as SessionId, { prompt: "x" })).rejects.toThrow(/2 running subagents/);
  });

  it("the parent agent's tools neither list nor reach its sessions", async () => {
    const { mgr } = mgrOver([top("root"), kid("ses", "root", "session", true), kid("sub", "root")]);
    expect((await mgr.list("root" as SessionId)).map((s) => s.id)).toEqual(["sub"]);
    expect(await mgr.check("root" as SessionId, "ses")).toBeUndefined();
    expect(await mgr.cancel("root" as SessionId, "ses")).toEqual({ outcome: "unknown" });
    expect(await mgr.send("root" as SessionId, "ses", "hi")).toEqual({ outcome: "unknown" });
  });
});
