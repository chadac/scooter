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
  return ok(st.lastActivity ? `${header}\n\n${st.lastActivity}` : header);
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
