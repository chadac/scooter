/**
 * Scheduler agent-tools: a thin typed front over the scheduler service's REST API
 * that lets the agent manage scheduled tasks (cron-spawned conversations), scoped to
 * the conversation's owner so it can never touch someone else's schedules. Handlers
 * are pure and registerSchedulerTools wires them onto the MCP server.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolResult } from "./agentTools.js";

/** One scheduled task as the scheduler API returns it. */
export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  timezone: string;
  owner: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  /** Conversation each run prompts; null spawns a new one. */
  conversation_id?: string | null;
}

/** A run record. */
export interface TaskRun {
  id: string;
  task_id: string;
  conversation_id: string | null;
  status: string;
  error: string | null;
  fired_at: string;
}

/** The scope a scheduler call runs under: a specific owner, or `null` for the unowned/anonymous bucket, which is a valid scope rather than an error. */
export type Owner = string | null;

/** Client to the scheduler service, where every call is made on behalf of `owner` via the x-auth-user header. */
export interface SchedulerClient {
  create(
    owner: Owner,
    body: { title: string; prompt: string; cron: string; timezone?: string; enabled?: boolean; conversation_id?: string | null },
  ): Promise<ScheduledTask>;
  list(owner: Owner): Promise<ScheduledTask[]>;
  get(owner: Owner, id: string): Promise<ScheduledTask | null>;
  patch(
    owner: Owner,
    id: string,
    body: Partial<Pick<ScheduledTask, "title" | "prompt" | "cron" | "timezone" | "enabled">>,
  ): Promise<ScheduledTask | null>;
  del(owner: Owner, id: string): Promise<boolean>;
  runs(owner: Owner, id: string): Promise<TaskRun[]>;
}

export interface SchedulerToolsWiring {
  client: SchedulerClient;
  /** Resolve this conversation's owner, which tasks are scoped to; null manages the unowned bucket. */
  owner(conversationId: string): Promise<Owner>;
  /** Any conversation's owner; undefined when it doesn't exist. */
  conversationOwner: ConversationOwnerLookup;
}

/** Owner (null if unowned), or undefined for no such conversation. */
export type ConversationOwnerLookup = (conversationId: string) => Promise<{ owner: Owner } | undefined>;

/** Why `owner` can't target `conversationId`; undefined if allowed. */
export async function targetError(lookup: ConversationOwnerLookup, owner: Owner, conversationId: string): Promise<string | undefined> {
  const found = await lookup(conversationId);
  // Others' conversations read as missing, so ids can't be probed.
  if (!found || (found.owner ?? null) !== (owner ?? null)) return `No conversation ${conversationId} (or it isn't yours).`;
  return undefined;
}

/** Resolve the tool's `conversation_id`, where "this" names the calling conversation. */
function resolveTarget(target: string | null | undefined, conversationId: string): string | null | undefined {
  if (typeof target !== "string") return target;
  const t = target.trim();
  if (t === "") return null;
  return t === "this" ? conversationId : t;
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** One-line task header: id, state, title, schedule and target. */
function header(t: ScheduledTask): string {
  const state = t.enabled ? "enabled" : "disabled";
  const next = t.next_run_at ? ` next=${t.next_run_at}` : "";
  const target = t.conversation_id ? ` → conv ${t.conversation_id}` : "";
  return `- ${t.id} [${state}] "${t.title}" — cron="${t.cron}" tz=${t.timezone}${next}${target}`;
}

/** Render a task compactly for the model, with a prompt preview. */
function fmt(t: ScheduledTask): string {
  return `${header(t)}\n    ${t.prompt.replace(/\s+/g, " ").slice(0, 120)}`;
}

// --- pure handlers ----------------------------

export async function handleList(w: SchedulerToolsWiring, conversationId: string): Promise<ToolResult> {
  const owner = await w.owner(conversationId);
  const tasks = await w.client.list(owner);
  if (tasks.length === 0) return ok("You have no scheduled tasks.");
  return ok(`Your scheduled tasks (${tasks.length}):\n` + tasks.map(fmt).join("\n"));
}

export async function handleSearch(w: SchedulerToolsWiring, conversationId: string, args: { query: string }): Promise<ToolResult> {
  const owner = await w.owner(conversationId);
  const q = (args.query ?? "").toLowerCase().trim();
  if (!q) return err("search: provide a non-empty query.");
  const hits = (await w.client.list(owner)).filter(
    (t) => t.title.toLowerCase().includes(q) || t.prompt.toLowerCase().includes(q),
  );
  if (hits.length === 0) return ok(`No scheduled tasks match "${args.query}".`);
  return ok(`Matches for "${args.query}" (${hits.length}):\n` + hits.map(fmt).join("\n"));
}

export async function handleView(w: SchedulerToolsWiring, conversationId: string, args: { id: string }): Promise<ToolResult> {
  const owner = await w.owner(conversationId);
  const t = await w.client.get(owner, args.id);
  if (!t) return err(`No scheduled task ${args.id} (or it isn't yours).`);
  const runs = await w.client.runs(owner, args.id);
  const recent = runs.slice(0, 5).map((r) => `    ${r.fired_at} → ${r.status}${r.conversation_id ? ` (conv ${r.conversation_id})` : ""}${r.error ? ` err: ${r.error}` : ""}`).join("\n");
  // Full prompt: edit replaces it wholesale, so a preview would lose text.
  const body = `${header(t)}\n  prompt:\n${t.prompt}`;
  return ok(body + (recent ? `\n  recent runs:\n${recent}` : "\n  (no runs yet)"));
}

export async function handleCreate(
  w: SchedulerToolsWiring,
  conversationId: string,
  args: { title: string; prompt: string; cron: string; timezone?: string; enabled?: boolean; conversation_id?: string },
): Promise<ToolResult> {
  const owner = await w.owner(conversationId);
  const target = resolveTarget(args.conversation_id, conversationId);
  if (target) {
    const bad = await targetError(w.conversationOwner, owner, target);
    if (bad) return err(`Couldn't create the task: ${bad}`);
  }
  try {
    const t = await w.client.create(owner, { ...args, conversation_id: target ?? null });
    const where = t.conversation_id ? ` Each run prompts conversation ${t.conversation_id}.` : "";
    return ok(`Created scheduled task ${t.id} "${t.title}" (cron="${t.cron}", tz=${t.timezone}). Next run: ${t.next_run_at ?? "—"}.${where}`);
  } catch (e) {
    return err(`Couldn't create the task: ${(e as Error)?.message ?? e}`);
  }
}

export async function handleEdit(
  w: SchedulerToolsWiring,
  conversationId: string,
  args: { id: string; title?: string; prompt?: string; cron?: string; timezone?: string; enabled?: boolean },
): Promise<ToolResult> {
  const owner = await w.owner(conversationId);
  const { id, ...fields } = args;
  try {
    const t = await w.client.patch(owner, id, fields);
    if (!t) return err(`No scheduled task ${id} (or it isn't yours).`);
    const where = t.conversation_id ? `prompts conversation ${t.conversation_id}` : "spawns a fresh conversation";
    return ok(`Updated scheduled task ${t.id}. Now: cron="${t.cron}", ${t.enabled ? "enabled" : "disabled"}, next ${t.next_run_at ?? "—"}, ${where} each run.`);
  } catch (e) {
    return err(`Couldn't update the task: ${(e as Error)?.message ?? e}`);
  }
}

export async function handleDelete(w: SchedulerToolsWiring, conversationId: string, args: { id: string }): Promise<ToolResult> {
  const owner = await w.owner(conversationId);
  const gone = await w.client.del(owner, args.id);
  return gone ? ok(`Deleted scheduled task ${args.id}.`) : err(`No scheduled task ${args.id} (or it isn't yours).`);
}

// --- MCP registration ---------------------------------------------------------

const TARGET_DESCRIPTION =
  "An existing conversation of yours that each run prompts instead of spawning a new one; 'this' means the current conversation. " +
  "If it is busy the prompt queues; if it is deleted the task disables itself. Fixed once the task is created.";

/** Register the scheduled-task tools onto `server`, bound to `conversationId`. */
export function registerSchedulerTools(server: McpServer, wiring: SchedulerToolsWiring, conversationId: string): void {
  const R = <A>(name: string, meta: { title: string; description: string; inputSchema: z.ZodRawShape }, run: (a: A) => Promise<ToolResult>) =>
    server.registerTool(name, meta, (a) => run(a as A) as Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>);

  R("list_scheduled_tasks",
    { title: "List scheduled tasks", description: "List YOUR scheduled tasks (recurring prompts that, on a cron schedule, spawn a fresh conversation or prompt an existing one).", inputSchema: {} },
    () => handleList(wiring, conversationId));

  R("search_scheduled_tasks",
    { title: "Search scheduled tasks", description: "Find your scheduled tasks whose title or prompt matches a query.", inputSchema: { query: z.string().describe("Substring to match in the task title or prompt.") } },
    (a: { query: string }) => handleSearch(wiring, conversationId, a));

  R("view_scheduled_task",
    { title: "View a scheduled task", description: "Show one scheduled task in detail: its full, untruncated prompt and its recent run history.", inputSchema: { id: z.string().describe("The task id.") } },
    (a: { id: string }) => handleView(wiring, conversationId, a));

  R("create_scheduled_task",
    {
      title: "Create a scheduled task",
      description:
        "Create a recurring task: on the given cron schedule, Scooter spawns a FRESH conversation with `prompt` and runs it, " +
        "or, with `conversation_id`, sends `prompt` to that existing conversation instead. " +
        "Use for 'every weekday 9am, check X and post a summary'. The task is owned by you.",
      inputSchema: {
        title: z.string().describe("Short human name for the task."),
        prompt: z.string().describe("The instruction sent as the user message each run."),
        cron: z.string().describe("A standard 5-field cron expression, e.g. '0 9 * * 1-5' for 9am on weekdays."),
        timezone: z.string().optional().describe("IANA timezone (default UTC), e.g. 'America/New_York'."),
        enabled: z.boolean().optional().describe("Whether it runs (default true)."),
        conversation_id: z.string().optional().describe(TARGET_DESCRIPTION),
      },
    },
    (a: { title: string; prompt: string; cron: string; timezone?: string; enabled?: boolean; conversation_id?: string }) => handleCreate(wiring, conversationId, a));

  R("edit_scheduled_task",
    {
      title: "Edit a scheduled task",
      description: "Update a scheduled task's title, prompt, cron, timezone or enabled state. Its target conversation is fixed at creation; to change it, delete and recreate the task.",
      inputSchema: {
        id: z.string().describe("The task id."),
        title: z.string().optional(),
        prompt: z.string().optional(),
        cron: z.string().optional().describe("A 5-field cron expression."),
        timezone: z.string().optional(),
        enabled: z.boolean().optional(),
      },
    },
    (a: { id: string; title?: string; prompt?: string; cron?: string; timezone?: string; enabled?: boolean }) => handleEdit(wiring, conversationId, a));

  R("delete_scheduled_task",
    { title: "Delete a scheduled task", description: "Permanently delete one of your scheduled tasks.", inputSchema: { id: z.string().describe("The task id.") } },
    (a: { id: string }) => handleDelete(wiring, conversationId, a));
}
