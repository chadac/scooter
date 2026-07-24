/**
 * Tier 1 — the scheduled-task agent tools: pure handlers over a fake SchedulerClient.
 * Asserts owner-scoping (no owner → clear refusal) and the client is called on behalf
 * of the conversation's owner.
 */

import { describe, it, expect } from "vitest";

import {
  handleList, handleSearch, handleView, handleCreate, handleEdit, handleDelete,
  type SchedulerClient, type SchedulerToolsWiring, type ScheduledTask, type Owner,
} from "../../src/agent/schedulerTools.js";

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "t1", title: "Daily check", prompt: "check the dashboard", cron: "0 9 * * *",
  timezone: "UTC", owner: "alice", enabled: true, next_run_at: "2026-07-25T09:00:00Z", last_run_at: null, ...over,
});

/** A fake client recording who it was called for + serving canned tasks. A null
 *  owner and the empty-string owner are the SAME unowned bucket (the HTTP client
 *  sends "" for null), so match on the normalized key. */
function fakeClient(tasks: ScheduledTask[] = []) {
  const calls: Array<{ method: string; owner: Owner; arg?: unknown }> = [];
  const owns = (t: ScheduledTask, owner: Owner) => t.owner === (owner ?? "");
  const client: SchedulerClient = {
    async create(owner, body) { calls.push({ method: "create", owner, arg: body }); return task({ ...body, owner: owner ?? "", id: "new" } as Partial<ScheduledTask>); },
    async list(owner) { calls.push({ method: "list", owner }); return tasks.filter((t) => owns(t, owner)); },
    async get(owner, id) { calls.push({ method: "get", owner, arg: id }); return tasks.find((t) => t.id === id && owns(t, owner)) ?? null; },
    async patch(owner, id, body) { calls.push({ method: "patch", owner, arg: { id, body } }); const t = tasks.find((x) => x.id === id && owns(x, owner)); return t ? task({ ...t, ...body }) : null; },
    async del(owner, id) { calls.push({ method: "del", owner, arg: id }); return tasks.some((t) => t.id === id && owns(t, owner)); },
    async runs(owner, id) { calls.push({ method: "runs", owner, arg: id }); void id; return []; },
  };
  return { client, calls };
}

const wiringFor = (owner: Owner, tasks: ScheduledTask[] = []): { wiring: SchedulerToolsWiring; calls: ReturnType<typeof fakeClient>["calls"] } => {
  const { client, calls } = fakeClient(tasks);
  return { wiring: { client, owner: async () => owner }, calls };
};

const CONV = "conv-1";

describe("scheduler agent tools", () => {
  it("list scopes to the conversation owner", async () => {
    const { wiring, calls } = wiringFor("alice", [task(), task({ id: "t2", owner: "bob" })]);
    const res = await handleList(wiring, CONV);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("t1");
    expect(res.content[0].text).not.toContain("t2"); // bob's task isn't shown
    expect(calls[0]).toMatchObject({ method: "list", owner: "alice" });
  });

  it("allows a null owner (the unowned bucket) — lists unowned tasks, no refusal", async () => {
    // A task with owner "" is the unowned bucket; wiring resolves owner -> null,
    // and the fake client filters list by owner === owner, so null matches "".
    const { wiring, calls } = wiringFor(null, [task({ owner: "" }), task({ id: "t2", owner: "alice" })]);
    const res = await handleList(wiring, CONV);
    expect(res.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "list", owner: null });
    expect(res.content[0].text).toContain("t1");
    expect(res.content[0].text).not.toContain("t2"); // alice's task isn't in the unowned bucket
  });

  it("search filters by title/prompt", async () => {
    const { wiring } = wiringFor("alice", [task({ title: "CI summary" }), task({ id: "t2", title: "deploy", prompt: "ship it" })]);
    const res = await handleSearch(wiring, CONV, { query: "ci" });
    expect(res.content[0].text).toContain("t1");
    expect(res.content[0].text).not.toContain("t2");
  });

  it("view returns the task + is scoped (someone else's id → not found)", async () => {
    const { wiring } = wiringFor("alice", [task({ id: "t2", owner: "bob" })]);
    const res = await handleView(wiring, CONV, { id: "t2" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/isn't yours|no scheduled task/i);
  });

  it("create passes the owner + task fields to the client", async () => {
    const { wiring, calls } = wiringFor("alice");
    const res = await handleCreate(wiring, CONV, { title: "morning", prompt: "do X", cron: "0 8 * * *" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/Created scheduled task/);
    expect(calls[0]).toMatchObject({ method: "create", owner: "alice", arg: { title: "morning", cron: "0 8 * * *" } });
  });

  it("edit updates a scoped task", async () => {
    const { wiring, calls } = wiringFor("alice", [task()]);
    const res = await handleEdit(wiring, CONV, { id: "t1", enabled: false });
    expect(res.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ method: "patch", owner: "alice" });
  });

  it("delete refuses a task not owned by the conversation owner", async () => {
    const { wiring } = wiringFor("alice", [task({ id: "t9", owner: "bob" })]);
    const res = await handleDelete(wiring, CONV, { id: "t9" });
    expect(res.isError).toBe(true);
  });
});
