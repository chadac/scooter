/**
 * Tier 1 — the SubagentManager IMPL (createSubagentManager) over a controllable
 * fake sessions + store. This covers the real send/recentTurns/searchHistory logic
 * that the handler tests (over a fake manager) don't — including the send status
 * gate that behaved oddly live (a child shown "running" must accept a send). See
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

/** A fake child whose run-state we control via `running`. */
function child(id: string, parentId: string | undefined, running: boolean, ended = false): SubagentConversation {
  return {
    id,
    parentId,
    title: `child ${id}`,
    status: ended ? "ended" : undefined,
    bridge: {
      queueState: () => ({ running }),
      cancel: vi.fn(),
    },
  };
}

/** Fake sessions + store over a fixed set of children + per-id event logs. */
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
      // It prompted the CHILD (not the parent), at PRIORITY_INTERRUPT, sourced.
      expect(prompt).toHaveBeenCalledTimes(1);
      const [id, text, , priority, interrupt, , , source] = prompt.mock.calls[0];
      expect(id).toBe("sub-a");
      expect(text).toContain("focus on login()");
      expect(priority).toBe(10); // PRIORITY_INTERRUPT
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
      expect((await mgr.searchHistory(PARENT, "sub-a", "grep"))?.length).toBe(1); // tool line
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
      expect(listed.map((c) => c.id).sort()).toEqual(["sub-a", "sub-b"]); // not sub-x
      expect(listed.find((c) => c.id === "sub-a")?.status).toBe("running");
      expect(listed.find((c) => c.id === "sub-b")?.status).toBe("idle");
      expect(await mgr.check(PARENT, "sub-x")).toBeUndefined(); // not YOUR child
    });
  });
});
