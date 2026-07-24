/**
 * Scheduler agent-tools — let the agent view/list/search/create/edit/delete its own
 * scheduled tasks, from inside a conversation.
 *
 * A scheduled task cron-spawns a fresh Scooter conversation with a prompt (the
 * scheduler service, services/scheduler). These MCP tools are a thin, typed front
 * over its REST API (SCHEDULER_URL), SCOPED to the conversation's owner: the agent
 * only ever sees/edits tasks owned by the same user who owns this conversation, so
 * it can't touch someone else's schedules.
 *
 * Handlers are pure (an injected SchedulerClient + owner) so they're unit-testable
 * without HTTP; registerSchedulerTools wires them onto the MCP server. Mirrors
 * agentTools.ts (pure handlers + a register fn).
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
}

/** A run record (history). */
export interface TaskRun {
  id: string;
  task_id: string;
  conversation_id: string | null;
  status: string;
  error: string | null;
  fired_at: string;
}

/** HTTP client to the scheduler service. Injectable for tests. Every call is made
 *  on behalf of `owner` (the conversation owner) — the client sets the x-auth-user
 *  header so the scheduler scopes/attributes the task to that user. */
export interface SchedulerClient {
  create(owner: string, body: { title: string; prompt: string; cron: string; timezone?: string; enabled?: boolean }): Promise<ScheduledTask>;
  list(owner: string): Promise<ScheduledTask[]>;
  get(owner: string, id: string): Promise<ScheduledTask | null>;
  patch(owner: string, id: string, body: Partial<Pick<ScheduledTask, "title" | "prompt" | "cron" | "timezone" | "enabled">>): Promise<ScheduledTask | null>;
  del(owner: string, id: string): Promise<boolean>;
  runs(owner: string, id: string): Promise<TaskRun[]>;
}

export interface SchedulerToolsWiring {
  client: SchedulerClient;
  /** Resolve THIS conversation's owner — tasks are scoped to it. Null → the agent
   *  can't manage tasks (no owner to scope to); the tools return a clear message. */
  owner(conversationId: string): Promise<string | null>;
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Render a task compactly for the model. */
function fmt(t: ScheduledTask): string {
  const state = t.enabled ? "enabled" : "disabled";
  const next = t.next_run_at ? ` next=${t.next_run_at}` : "";
  return `- ${t.id} [${state}] "${t.title}" — cron="${t.cron}" tz=${t.timezone}${next}\n    ${t.prompt.replace(/\s+/g, " ").slice(0, 120)}`;
}

// --- pure handlers (no MCP; take the wiring + args) ----------------------------

export async function handleList(w: SchedulerToolsWiring, conversationId: string): Promise<ToolResult> {
  const owner = await w.owner(conversationId);
  if (!owner) return err("This conversation has no owner, so scheduled tasks can't be managed here.");
  const tasks = await w.client.list(owner);
  if (tasks.length === 0) return ok("You have no scheduled tasks.");
  return ok(`Your scheduled tasks (${tasks.length}):\n` + tasks.map(fmt).join("\n"));
}

export async function handleSearch(w: SchedulerToolsWiring, conversationId: string, args: { query: string }): Promise<ToolResult> {
  const owner = await w.owner(conversationId);
  if (!owner) return err("This conversation has no owner, so scheduled tasks can't be managed here.");
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
  if (!owner) return err("This conversation has no owner, so scheduled tasks can't be managed here.");
  const t = await w.client.get(owner, args.id);
  if (!t) return err(`No scheduled task ${args.id} (or it isn't yours).`);
  const runs = await w.client.runs(owner, args.id);
  const recent = runs.slice(0, 5).map((r) => `    ${r.fired_at} → ${r.status}${r.conversation_id ? ` (conv ${r.conversation_id})` : ""}${r.error ? ` err: ${r.error}` : ""}`).join("\n");
  return ok(fmt(t) + (recent ? `\n  recent runs:\n${recent}` : "\n  (no runs yet)"));
}

export async function handleCreate(
  w: SchedulerToolsWiring,
  conversationId: string,
  args: { title: string; prompt: string; cron: string; timezone?: string; enabled?: boolean },
): Promise<ToolResult> {
  const owner = await w.owner(conversationId);
  if (!owner) return err("This conversation has no owner, so scheduled tasks can't be created here.");
  try {
    const t = await w.client.create(owner, args);
    return ok(`Created scheduled task ${t.id} "${t.title}" (cron="${t.cron}", tz=${t.timezone}). Next run: ${t.next_run_at ?? "—"}.`);
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
  if (!owner) return err("This conversation has no owner, so scheduled tasks can't be edited here.");
  const { id, ...fields } = args;
  try {
    const t = await w.client.patch(owner, id, fields);
    if (!t) return err(`No scheduled task ${id} (or it isn't yours).`);
    return ok(`Updated scheduled task ${t.id}. Now: cron="${t.cron}", ${t.enabled ? "enabled" : "disabled"}, next ${t.next_run_at ?? "—"}.`);
  } catch (e) {
    return err(`Couldn't update the task: ${(e as Error)?.message ?? e}`);
  }
}

export async function handleDelete(w: SchedulerToolsWiring, conversationId: string, args: { id: string }): Promise<ToolResult> {
  const owner = await w.owner(conversationId);
  if (!owner) return err("This conversation has no owner, so scheduled tasks can't be deleted here.");
  const gone = await w.client.del(owner, args.id);
  return gone ? ok(`Deleted scheduled task ${args.id}.`) : err(`No scheduled task ${args.id} (or it isn't yours).`);
}

// --- MCP registration ---------------------------------------------------------

/** Register the scheduled-task tools onto `server`, bound to `conversationId`. */
export function registerSchedulerTools(server: McpServer, wiring: SchedulerToolsWiring, conversationId: string): void {
  const R = <A>(name: string, meta: { title: string; description: string; inputSchema: z.ZodRawShape }, run: (a: A) => Promise<ToolResult>) =>
    server.registerTool(name, meta, (a) => run(a as A) as Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>);

  R("list_scheduled_tasks",
    { title: "List scheduled tasks", description: "List YOUR scheduled tasks (recurring prompts that spawn a fresh conversation on a cron schedule).", inputSchema: {} },
    () => handleList(wiring, conversationId));

  R("search_scheduled_tasks",
    { title: "Search scheduled tasks", description: "Find your scheduled tasks whose title or prompt matches a query.", inputSchema: { query: z.string().describe("Substring to match in the task title or prompt.") } },
    (a: { query: string }) => handleSearch(wiring, conversationId, a));

  R("view_scheduled_task",
    { title: "View a scheduled task", description: "Show one scheduled task in detail, including its recent run history.", inputSchema: { id: z.string().describe("The task id.") } },
    (a: { id: string }) => handleView(wiring, conversationId, a));

  R("create_scheduled_task",
    {
      title: "Create a scheduled task",
      description:
        "Create a recurring task: on the given cron schedule, Scooter spawns a FRESH conversation with `prompt` and runs it. " +
        "Use for 'every weekday 9am, check X and post a summary'. The task is owned by you.",
      inputSchema: {
        title: z.string().describe("Short human name for the task."),
        prompt: z.string().describe("The instruction sent as the user message each run."),
        cron: z.string().describe("A standard 5-field cron expression, e.g. '0 9 * * 1-5' for 9am on weekdays."),
        timezone: z.string().optional().describe("IANA timezone (default UTC), e.g. 'America/New_York'."),
        enabled: z.boolean().optional().describe("Whether it runs (default true)."),
      },
    },
    (a: { title: string; prompt: string; cron: string; timezone?: string; enabled?: boolean }) => handleCreate(wiring, conversationId, a));

  R("edit_scheduled_task",
    {
      title: "Edit a scheduled task",
      description: "Update a scheduled task's title, prompt, cron, timezone, or enabled state.",
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
