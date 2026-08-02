/**
 * Tier 1 contract — the subagent MCP tool handlers (RED-FIRST; see
 * todo/docs/SUBAGENTS.md).
 *
 * Pure handlers (no MCP plumbing), same shape as the background-job handlers:
 *   spawn_subagent(prompt, title?, model?) -> a subagent id + a poll hint
 *   list_subagents()                       -> this conversation's children
 *   check_subagent(subagent_id)            -> status + last activity + result?
 *   cancel_subagent(subagent_id)           -> stop the child's run
 *
 * The handlers talk to a small SubagentManager seam (implemented over the
 * SessionManager) so they're unit-testable without a real bridge/pod.
 */

import { describe, it, expect, vi } from "vitest";

import {
  handleSpawnSubagent,
  handleListSubagents,
  handleCheckSubagent,
  handleCancelSubagent,
  lastAssistantText,
  subagentDoneNotice,
  type SubagentManager,
} from "../../src/agent/subagentTools.js";
import type { AguiEvent } from "../../src/bridge.js";

const fakeManager = (over: Partial<SubagentManager> = {}): SubagentManager => ({
  spawn: vi.fn(async (_parentId, args) => ({ id: `sub-${args.prompt.slice(0, 3)}`, title: args.title })),
  list: vi.fn(async () => [
    { id: "sub-a", title: "research A", status: "running" },
    { id: "sub-b", title: "research B", status: "ended" },
  ]),
  check: vi.fn(async (_parentId, id) => ({ id, status: "running", lastActivity: "working on it" })),
  cancel: vi.fn(async () => ({ outcome: "cancelled" })),
  ...over,
});

const PARENT = "conv-parent";

describe("subagent tools", () => {
  it("spawn_subagent starts a child + returns its id with a poll hint", async () => {
    const mgr = fakeManager();
    const out = await handleSpawnSubagent(mgr, PARENT, { prompt: "research the API" });
    expect(out.isError).toBeFalsy();
    expect(mgr.spawn).toHaveBeenCalledWith(PARENT, { prompt: "research the API" });
    const text = out.content[0].text;
    expect(text).toContain("sub-res"); // the id
    expect(text).toMatch(/check_subagent/i); // tells the agent how to poll
  });

  it("spawn_subagent errors on an empty prompt (no child started)", async () => {
    const mgr = fakeManager();
    const out = await handleSpawnSubagent(mgr, PARENT, { prompt: "   " });
    expect(out.isError).toBe(true);
    expect(mgr.spawn).not.toHaveBeenCalled();
  });

  it("list_subagents lists this conversation's children + statuses", async () => {
    const mgr = fakeManager();
    const out = await handleListSubagents(mgr, PARENT);
    expect(mgr.list).toHaveBeenCalledWith(PARENT);
    expect(out.content[0].text).toContain("sub-a");
    expect(out.content[0].text).toContain("sub-b");
  });

  it("check_subagent reports status + last activity", async () => {
    const mgr = fakeManager();
    const out = await handleCheckSubagent(mgr, PARENT, { subagent_id: "sub-a" });
    expect(mgr.check).toHaveBeenCalledWith(PARENT, "sub-a");
    expect(out.content[0].text).toMatch(/running/i);
  });

  it("check_subagent tells a RUNNING subagent's poller to STOP polling + end its turn", async () => {
    // The livelock fix: a busy check_subagent poll loop keeps the parent busy, so
    // the event-driven result can't land. A "running" check must steer the agent
    // to end its turn — it'll be nudged automatically when the subagent finishes.
    const mgr = fakeManager({ check: vi.fn(async (_p, id) => ({ id, status: "running", lastActivity: "x" })) });
    const out = await handleCheckSubagent(mgr, PARENT, { subagent_id: "sub-a" });
    expect(out.content[0].text).toMatch(/end your turn|do not (keep )?poll|you'?ll be (told|notified)/i);
  });

  it("check_subagent does NOT tell a finished subagent's poller to wait", async () => {
    const mgr = fakeManager({ check: vi.fn(async (_p, id) => ({ id, status: "ended", lastActivity: "the result" })) });
    const out = await handleCheckSubagent(mgr, PARENT, { subagent_id: "sub-a" });
    expect(out.content[0].text).not.toMatch(/end your turn|do not (keep )?poll/i);
  });

  it("check_subagent errors on a missing id", async () => {
    const out = await handleCheckSubagent(fakeManager(), PARENT, { subagent_id: "" });
    expect(out.isError).toBe(true);
  });

  it("check_subagent errors when the child isn't a child of THIS conversation", async () => {
    // Guard: a caller can only inspect its OWN children (the manager returns
    // undefined for a foreign / unknown id).
    const mgr = fakeManager({ check: vi.fn(async () => undefined) });
    const out = await handleCheckSubagent(mgr, PARENT, { subagent_id: "sub-foreign" });
    expect(out.isError).toBe(true);
  });

  it("cancel_subagent stops the child's run", async () => {
    const mgr = fakeManager();
    const out = await handleCancelSubagent(mgr, PARENT, { subagent_id: "sub-a" });
    expect(mgr.cancel).toHaveBeenCalledWith(PARENT, "sub-a");
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/cancel/i);
  });
});

// The completion-watcher building blocks (the "result = last message" convention).
describe("subagent completion (last-message result)", () => {
  const t = (id: string, role: "assistant" | "user", text: string): AguiEvent[] => [
    { type: "TEXT_MESSAGE_START", messageId: id, role },
    { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
    { type: "TEXT_MESSAGE_END", messageId: id },
  ];

  it("lastAssistantText concatenates the LAST assistant message's deltas", () => {
    const events: AguiEvent[] = [
      ...t("u1", "user", "do the thing"),
      ...t("a1", "assistant", "working"),
      ...t("a2", "assistant", "I found "),
      { type: "TEXT_MESSAGE_START", messageId: "a2b", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a2b", delta: "the bug" }, // separate id, later
      { type: "TEXT_MESSAGE_END", messageId: "a2b" },
    ];
    expect(lastAssistantText(events)).toBe("the bug");
  });

  it("lastAssistantText ignores user messages + returns undefined when none", () => {
    expect(lastAssistantText([...t("u1", "user", "hi")])).toBeUndefined();
    expect(lastAssistantText([])).toBeUndefined();
  });

  it("subagentDoneNotice frames the child's result for injection into the parent", () => {
    const text = subagentDoneNotice("sub-a", "research A", "found 3 issues");
    expect(text).toContain("sub-a");
    expect(text).toContain("research A");
    expect(text).toContain("found 3 issues");
  });

  it("subagentDoneNotice handles a subagent that reported no final text", () => {
    const text = subagentDoneNotice("sub-a", "research A", undefined);
    expect(text).toContain("sub-a");
    expect(text).toMatch(/no (result|final)/i);
  });
});
