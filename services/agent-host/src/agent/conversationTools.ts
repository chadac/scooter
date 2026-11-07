/**
 * The conversation_status and make_conversation_private MCP tools. Going private only ever
 * narrows access: an agent may take a shared conversation private so the broker vends its
 * owner's personal credentials, but going back to shared stays an owner-only action in the
 * UI (PATCH /visibility).
 */

import type { ToolResult } from "./mcpServer.js";
import type { Conversation } from "../session/manager.js";
import type { SandboxResources } from "../session/resources.js";
import type { Visibility } from "../session/visibility.js";
import type { SandboxRef } from "../types.js";
import { formatPodWait, podWaitStatus } from "../exec/podReadiness.js";

/** " — but the sandbox pod has not been Ready for 3m" while a readiness wait on this sandbox hasn't succeeded. */
function podWaitNote(sandbox: SandboxRef | undefined, now: number): string {
  const w = sandbox && podWaitStatus(sandbox, now);
  return w ? ` — but ${formatPodWait(w, now)}` : "";
}

/** What the conversation tools need from the agent-host. */
export interface ConversationToolsWiring {
  /** The conversation by id, undefined if unknown. */
  get(conversationId: string): Conversation | undefined;
  /** The root's visibility as the shared store has it now. */
  currentVisibility(rootId: string): Promise<Visibility>;
  /** Make the root, and with it every subagent, private. */
  makePrivate(rootId: string): Promise<void>;
  /** The sandbox's recorded size; absent for a fake sandbox. */
  resources?(rootId: string): Promise<SandboxResources>;
}

const text = (t: string, isError = false): ToolResult => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text", text: t }],
});

/** The top-level conversation `id` runs under: itself unless a subagent. */
function rootOf(deps: ConversationToolsWiring, id: string): Conversation | undefined {
  let c = deps.get(id);
  while (c?.parentId) c = deps.get(c.parentId);
  return c;
}

/** A duration as its two largest units, e.g. "2h 5m". */
export function formatDuration(ms: number): string {
  let s = Math.max(0, Math.floor(ms / 1000));
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    if (parts.length > 0 || s >= size || unit === "s") parts.push(`${Math.floor(s / size)}${unit}`);
    s %= size;
  }
  return parts.slice(0, 2).join(" ");
}

/** conversation_status: who this conversation acts for and what it runs on. */
export async function handleConversationStatus(
  deps: ConversationToolsWiring,
  conversationId: string,
  now: number = Date.now(),
): Promise<ToolResult> {
  const self = deps.get(conversationId);
  const root = rootOf(deps, conversationId);
  if (!self || !root) return text("This conversation is not known here.", true);
  const visibility = await deps.currentVisibility(root.id);
  const lines = [
    `id: ${self.id}`,
    `title: ${self.title}`,
    ...(self.parentId ? [`subagent of: ${root.id} (shares its sandbox and visibility)`] : []),
    `owner: ${root.owner ?? "(none)"}`,
    `visibility: ${visibility} — ` +
      (visibility === "private"
        ? "the sandbox acts as the owner (their SSH key and commit identity)"
        : "anyone who can see it may prompt it; no personal credentials (see make_conversation_private)"),
    `model: ${self.model ?? "(host default)"}`,
    `sandbox: ${root.status}` + podWaitNote(root.sandbox, now),
    `age: ${formatDuration(now - self.createdAt)}; last activity ${formatDuration(now - self.lastActivityAt)} ago`,
  ];
  if (deps.resources) {
    const r = await deps.resources(root.id).catch(() => undefined);
    const side = (q?: { cpu?: string; memory?: string; gpu?: number }) =>
      [q?.cpu && `cpu=${q.cpu}`, q?.memory && `memory=${q.memory}`, q?.gpu && `gpu=${q.gpu}`].filter(Boolean).join(", ") || "(default)";
    lines.push(r ? `size: requests ${side(r.requests)}; limits ${side(r.limits)}` : "size: (unavailable)");
  }
  return text(lines.join("\n"));
}

/** make_conversation_private: shared → private, never the reverse. */
export async function handleMakeConversationPrivate(
  deps: ConversationToolsWiring,
  conversationId: string,
): Promise<ToolResult> {
  const root = rootOf(deps, conversationId);
  if (!root) return text("This conversation is not known here, so its visibility was not changed.", true);
  // No owner means nobody the private conversation could admit.
  if (!root.owner) {
    return text("This conversation has no owner, so it cannot be made private. Tell the user.", true);
  }
  if ((await deps.currentVisibility(root.id)) === "private") {
    return text("This conversation is already private; no change.");
  }
  await deps.makePrivate(root.id);
  return text(
    "This conversation is now private: only its owner can see or prompt it, and within a few " +
      "seconds the sandbox acts as them (their SSH key and commit identity). Only the owner can " +
      "make it shared again, from the UI.",
  );
}
