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
  type SubagentManager,
} from "../../src/agent/subagentTools.js";

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
