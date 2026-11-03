/**
 * The scheduled-task agent tools, pure handlers over a fake SchedulerClient: every call
 * is scoped to the conversation's owner.
 */

import { describe, it, expect } from "vitest";

import {
  handleList, handleSearch, handleView, handleCreate, handleEdit, handleDelete, registerSchedulerTools,
  type SchedulerClient, type SchedulerToolsWiring, type ScheduledTask, type Owner,
} from "../../src/agent/schedulerTools.js";

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "t1", title: "Daily check", prompt: "check the dashboard", cron: "0 9 * * *",
  timezone: "UTC", owner: "alice", enabled: true, next_run_at: "2026-07-25T09:00:00Z", last_run_at: null, ...over,
});

/** A fake client recording who it was called for and serving canned tasks, with null and "" as the same unowned bucket. */
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

/** Conversations by id and owner: conv-1 (the caller) and conv-mine are alice's, conv-bob is bob's. */
const CONVERSATIONS: Record<string, Owner> = { "conv-1": "alice", "conv-mine": "alice", "conv-bob": "bob" };

const wiringFor = (owner: Owner, tasks: ScheduledTask[] = []): { wiring: SchedulerToolsWiring; calls: ReturnType<typeof fakeClient>["calls"] } => {
  const { client, calls } = fakeClient(tasks);
  const conversationOwner = async (id: string) => (id in CONVERSATIONS ? { owner: CONVERSATIONS[id] } : undefined);
  return { wiring: { client, owner: async () => owner, conversationOwner }, calls };
};

const CONV = "conv-1";

describe("scheduler agent tools", () => {
  it("list scopes to the conversation owner", async () => {
    const { wiring, calls } = wiringFor("alice", [task(), task({ id: "t2", owner: "bob" })]);
    const res = await handleList(wiring, CONV);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("t1");
    expect(res.content[0].text).not.toContain("t2");
    expect(calls[0]).toMatchObject({ method: "list", owner: "alice" });
  });

  it("allows a null owner (the unowned bucket) — lists unowned tasks, no refusal", async () => {
    // A task with owner "" is the unowned bucket, which a null owner matches.
    const { wiring, calls } = wiringFor(null, [task({ owner: "" }), task({ id: "t2", owner: "alice" })]);
    const res = await handleList(wiring, CONV);
    expect(res.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "list", owner: null });
    expect(res.content[0].text).toContain("t1");
    expect(res.content[0].text).not.toContain("t2");
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

  it("view returns the full prompt, untruncated, with newlines kept", async () => {
    const prompt = "line one\n\n" + "x".repeat(500) + "\nTHE END";
    const { wiring } = wiringFor("alice", [task({ prompt })]);
    const res = await handleView(wiring, CONV, { id: "t1" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain(prompt);
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

describe("scheduler agent tools: target conversation", () => {
  const base = { title: "t", prompt: "p", cron: "0 9 * * *" };
  const sent = (calls: ReturnType<typeof fakeClient>["calls"], method: string) =>
    calls.find((c) => c.method === method)?.arg as Record<string, unknown> | undefined;

  it("create without a target spawns, sending conversation_id null", async () => {
    const { wiring, calls } = wiringFor("alice");
    const res = await handleCreate(wiring, CONV, base);
    expect(res.isError).toBeUndefined();
    expect(sent(calls, "create")).toMatchObject({ conversation_id: null });
  });

  it("create with 'this' targets the calling conversation", async () => {
    const { wiring, calls } = wiringFor("alice");
    const res = await handleCreate(wiring, CONV, { ...base, conversation_id: "this" });
    expect(res.isError).toBeUndefined();
    expect(sent(calls, "create")).toMatchObject({ conversation_id: CONV });
    expect(res.content[0].text).toContain(`prompts conversation ${CONV}`);
  });

  it("create may target another conversation the caller owns", async () => {
    const { wiring, calls } = wiringFor("alice");
    await handleCreate(wiring, CONV, { ...base, conversation_id: "conv-mine" });
    expect(sent(calls, "create")).toMatchObject({ conversation_id: "conv-mine" });
  });

  it("create refuses someone else's conversation and an unknown one alike, without calling the scheduler", async () => {
    for (const target of ["conv-bob", "conv-nope"]) {
      const { wiring, calls } = wiringFor("alice");
      const res = await handleCreate(wiring, CONV, { ...base, conversation_id: target });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("isn't yours");
      expect(calls.some((c) => c.method === "create")).toBe(false);
    }
  });

  it("edit without conversation_id leaves the target untouched", async () => {
    const { wiring, calls } = wiringFor("alice", [task()]);
    await handleEdit(wiring, CONV, { id: "t1", enabled: false });
    expect((sent(calls, "patch") as { body: object }).body).not.toHaveProperty("conversation_id");
  });

  it("the edit tool has no conversation_id input, since the target is fixed at creation", async () => {
    const tools = new Map<string, { inputSchema?: Record<string, unknown> }>();
    const server = { registerTool: (name: string, meta: { inputSchema?: Record<string, unknown> }) => tools.set(name, meta) };
    registerSchedulerTools(server as never, wiringFor("alice", []).wiring, CONV);
    expect(Object.keys(tools.get("edit_scheduled_task")?.inputSchema ?? {})).not.toContain("conversation_id");
    expect(Object.keys(tools.get("create_scheduled_task")?.inputSchema ?? {})).toContain("conversation_id");
  });
});
