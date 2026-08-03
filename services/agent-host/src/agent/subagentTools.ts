/**
 * Subagent MCP tools — the PARENT-side spawn/monitor/control surface (see
 * todo/docs/SUBAGENTS.md). Pure handlers (no MCP plumbing), same shape as the
 * background-job handlers (mcpServer.ts). Registered per conversation in
 * buildServer; the agent (parent OR a subagent — subagents are multi-level) calls
 * them to fan out + monitor children.
 *
 * There is NO subagent-side "report result" tool: a subagent is just a
 * conversation whose FINAL assistant message returns to its parent (the
 * last-message convention — matches the Claude CLI). The completion watcher
 * captures that and injects it into the parent.
 */

import type { SessionId } from "../types.js";
import type { AguiEvent } from "../bridge.js";
import { renderTurns, type SubagentTurn } from "./subagentTranscript.js";

/** An MCP tool result (matches mcpServer.ts's ToolResult). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** A subagent's status as the parent sees it. */
export interface SubagentStatus {
  id: string;
  title?: string;
  status: "running" | "idle" | "ended" | "error";
  /** A short human hint of what the child is doing now (e.g. its active tool), or
   *  its result summary once done. */
  lastActivity?: string;
}

/**
 * The seam the tools drive — implemented over the SessionManager (spawnChild +
 * child lookup by parentId + the child bridge's cancel). Kept narrow so the tool
 * handlers are unit-testable without a real bridge/pod.
 */
export interface SubagentManager {
  /** Spawn a child of `parentId`; returns its id (+ title). */
  spawn(
    parentId: SessionId,
    args: { prompt: string; title?: string; model?: string },
  ): Promise<{ id: string; title?: string }>;
  /** This conversation's children + their statuses. */
  list(parentId: SessionId): Promise<SubagentStatus[]>;
  /** One child's status — ONLY if it's a child of `parentId` (else undefined, so
   *  a caller can't inspect a conversation that isn't its subagent). */
  check(parentId: SessionId, subagentId: string): Promise<SubagentStatus | undefined>;
  /** Cancel a child's in-flight run (must be a child of `parentId`). */
  cancel(parentId: SessionId, subagentId: string): Promise<{ outcome: "cancelled" | "unknown" | "already-idle" }>;
  /** Send a CLARIFICATION that interrupts a RUNNING child's current turn (a course
   *  correction — the child keeps its fire-and-forget lifecycle). Fails if the
   *  child isn't running (idle/ended/error): nothing to clarify. Scoped to a child
   *  of `parentId`. */
  send(parentId: SessionId, subagentId: string, message: string): Promise<{ outcome: "sent" | "not-running" | "unknown" }>;
  /** A child's RECENT turns (last `n`) — text + compact tool summaries — so the
   *  parent can see what it's doing. undefined if not a child of `parentId`. */
  recentTurns(parentId: SessionId, subagentId: string, n: number): Promise<SubagentTurn[] | undefined>;
  /** Turns from a child's FULL history matching `query` (case-insensitive
   *  substring over turn text + tool summaries). undefined if not a child. */
  searchHistory(parentId: SessionId, subagentId: string, query: string): Promise<SubagentTurn[] | undefined>;
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

export async function handleSpawnSubagent(
  mgr: SubagentManager,
  conversationId: string,
  args: { prompt: string; title?: string; model?: string },
): Promise<ToolResult> {
  const prompt = (args.prompt ?? "").trim();
  if (!prompt) {
    return err("prompt is empty — describe the task for the subagent to work on.");
  }
  const { id, title } = await mgr.spawn(conversationId, { prompt, title: args.title, model: args.model });
  return ok(
    `Spawned subagent \`${id}\`${title ? ` (${title})` : ""}. It shares this ` +
      `conversation's sandbox (same /workspace + creds) and works in the background. ` +
      `Poll it with check_subagent("${id}"); its final message is its result.`,
  );
}

export async function handleListSubagents(
  mgr: SubagentManager,
  conversationId: string,
): Promise<ToolResult> {
  const kids = await mgr.list(conversationId);
  if (kids.length === 0) return ok("No subagents for this conversation.");
  const lines = kids
    .map((k) => `- ${k.id}${k.title ? ` (${k.title})` : ""}: ${k.status}${k.lastActivity ? ` — ${k.lastActivity}` : ""}`)
    .join("\n");
  return ok(`Subagents:\n${lines}`);
}

export async function handleCheckSubagent(
  mgr: SubagentManager,
  conversationId: string,
  args: { subagent_id: string },
): Promise<ToolResult> {
  const id = (args.subagent_id ?? "").trim();
  if (!id) return err("subagent_id is required.");
  const st = await mgr.check(conversationId, id);
  if (!st) {
    return err(`Subagent \`${id}\` is not a subagent of this conversation (or is unknown).`);
  }
  const header = `Subagent \`${id}\`${st.title ? ` (${st.title})` : ""} is ${st.status.toUpperCase()}.`;
  const body = st.lastActivity ? `${header}\n\n${st.lastActivity}` : header;
  // CRITICAL: if it's still running, tell the agent to STOP polling and END its
  // turn. A tight check_subagent poll loop keeps the parent continuously busy, so
  // the event-driven completion (which nudges the parent the instant the subagent
  // finishes) can never find an idle moment to land — the parent livelocks waiting
  // for a result it's blocking. Ending the turn lets the result arrive promptly.
  if (st.status === "running") {
    return ok(
      `${body}\n\nIt's still working — do NOT keep polling. END YOUR TURN now; ` +
        `you'll be nudged automatically with its result the moment it finishes. ` +
        `(Polling in a loop just delays that.)`,
    );
  }
  return ok(body);
}

export async function handleCancelSubagent(
  mgr: SubagentManager,
  conversationId: string,
  args: { subagent_id: string },
): Promise<ToolResult> {
  const id = (args.subagent_id ?? "").trim();
  if (!id) return err("subagent_id is required.");
  const res = await mgr.cancel(conversationId, id);
  if (res.outcome === "unknown") {
    return err(`Subagent \`${id}\` is not a subagent of this conversation (or is unknown).`);
  }
  return ok(
    res.outcome === "already-idle"
      ? `Subagent \`${id}\` had no run in flight — nothing to cancel (check_subagent for its result).`
      : `Cancelled subagent \`${id}\`'s current run.`,
  );
}

/** Defaults for monitor/search output size (caps keep the parent's context sane). */
const MONITOR_DEFAULT_TURNS = 6;
const MONITOR_MAX_TURNS = 30;
const SEARCH_MAX_RESULTS = 20;

export async function handleSendToSubagent(
  mgr: SubagentManager,
  conversationId: string,
  args: { subagent_id: string; message: string },
): Promise<ToolResult> {
  const id = (args.subagent_id ?? "").trim();
  const message = (args.message ?? "").trim();
  if (!id) return err("subagent_id is required.");
  if (!message) return err("message is empty — provide the clarification to send.");
  const res = await mgr.send(conversationId, id, message);
  if (res.outcome === "unknown") {
    return err(`Subagent \`${id}\` is not a subagent of this conversation (or is unknown).`);
  }
  if (res.outcome === "not-running") {
    return err(
      `Subagent \`${id}\` isn't running — there's no in-flight turn to clarify. ` +
        `(send_to_subagent only course-corrects a WORKING subagent; a finished one's ` +
        `result already came back to you, or use spawn_subagent for new work.)`,
    );
  }
  return ok(
    `Sent your clarification to subagent \`${id}\` — it will interrupt its current ` +
      `turn and factor it in. Its result still returns to you automatically when it ` +
      `finishes; use monitor_subagent("${id}") to watch its progress.`,
  );
}

export async function handleMonitorSubagent(
  mgr: SubagentManager,
  conversationId: string,
  args: { subagent_id: string; turns?: number },
): Promise<ToolResult> {
  const id = (args.subagent_id ?? "").trim();
  if (!id) return err("subagent_id is required.");
  const n = Math.min(Math.max(1, args.turns ?? MONITOR_DEFAULT_TURNS), MONITOR_MAX_TURNS);
  const turns = await mgr.recentTurns(conversationId, id, n);
  if (turns === undefined) {
    return err(`Subagent \`${id}\` is not a subagent of this conversation (or is unknown).`);
  }
  if (turns.length === 0) return ok(`Subagent \`${id}\` has no messages yet.`);
  return ok(`Recent activity of subagent \`${id}\` (last ${turns.length}):\n\n${renderTurns(turns)}`);
}

export async function handleSearchSubagent(
  mgr: SubagentManager,
  conversationId: string,
  args: { subagent_id: string; query: string },
): Promise<ToolResult> {
  const id = (args.subagent_id ?? "").trim();
  const query = (args.query ?? "").trim();
  if (!id) return err("subagent_id is required.");
  if (!query) return err("query is empty — provide text to search for.");
  const all = await mgr.searchHistory(conversationId, id, query);
  if (all === undefined) {
    return err(`Subagent \`${id}\` is not a subagent of this conversation (or is unknown).`);
  }
  if (all.length === 0) return ok(`No turns in subagent \`${id}\`'s history match "${query}".`);
  const shown = all.slice(0, SEARCH_MAX_RESULTS);
  const more = all.length > shown.length ? `\n\n…(${all.length - shown.length} more matches)` : "";
  return ok(`Matches for "${query}" in subagent \`${id}\`:\n\n${renderTurns(shown)}${more}`);
}

// --- Completion watcher building blocks (the "result = last message" convention) ---

/** The subagent's RESULT: the text of its LAST assistant message, concatenated
 *  from that message's content deltas. Undefined when it produced no assistant
 *  text (e.g. only tool calls). Matches the Claude CLI — a subagent's final
 *  message is what returns to the parent; no report tool. */
export function lastAssistantText(events: readonly AguiEvent[]): string | undefined {
  // Walk to find the last assistant message id, then gather its deltas.
  let lastId: string | undefined;
  for (const e of events) {
    if (e.type === "TEXT_MESSAGE_START" && e.role === "assistant") lastId = e.messageId;
  }
  if (!lastId) return undefined;
  let text = "";
  for (const e of events) {
    if (e.type === "TEXT_MESSAGE_CONTENT" && e.messageId === lastId) text += e.delta;
  }
  const trimmed = text.trim();
  return trimmed.length ? trimmed : undefined;
}

/** Frame a finished subagent's result for injection into the PARENT conversation
 *  (a SYSTEM message, source "subagent"). `result` undefined = it ended without a
 *  final text message. */
export function subagentDoneNotice(subagentId: string, title: string | undefined, result: string | undefined): string {
  const who = `Subagent \`${subagentId}\`${title ? ` (${title})` : ""}`;
  if (!result) {
    return (
      `${who} finished but reported no final result message. ` +
      `check_subagent("${subagentId}") to inspect it if needed.`
    );
  }
  return (
    `${who} finished. Its result:\n\n${result}\n\n` +
    `Use this if it's relevant to your task; otherwise acknowledge briefly.`
  );
}
