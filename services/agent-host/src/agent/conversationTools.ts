/**
 * The conversation_status, make_conversation_private and request_untaint MCP tools. Going
 * private only ever narrows access: an agent may take a shared conversation private so the
 * broker vends its owner's personal credentials, but going back to shared stays an owner-only
 * action in the UI (PATCH /visibility). Clearing a taint is the owner's too: the agent only asks.
 */

import type { ToolResult } from "./mcpServer.js";
import type { Conversation } from "../session/manager.js";
import type { SandboxResources } from "../session/resources.js";
import type { Visibility } from "../session/visibility.js";
import type { SandboxRef } from "../types.js";
import { formatPodWait, podWaitStatus } from "../exec/podReadiness.js";
import type { ResolvedAuthor } from "../session/authorStore.js";
import { describeTaint } from "../session/taint.js";

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
  /** Authors other than the owner across the tree. */
  taint?(conversationId: string, owner: string | undefined): Promise<ResolvedAuthor[]>;
  /** Put a card asking the owner to clear `authors` in the conversation. */
  requestUntaint?(conversationId: string, authors: ResolvedAuthor[], reason: string): Promise<void>;
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
        ? "only the owner can see or prompt it"
        : "anyone who can see it may prompt it; no personal credentials (see make_conversation_private)"),
    ...(visibility === "private" ? [await credentialsLine(deps, self.id, root.owner)] : []),
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

/** Whether a private conversation acts as its owner, and if not, who taints it. */
async function credentialsLine(deps: ConversationToolsWiring, id: string, owner: string | undefined): Promise<string> {
  if (!deps.taint) return "credentials: the owner's (SSH key, commit identity, forge tokens)";
  const authors = await deps.taint(id, owner).catch(() => undefined);
  if (!authors) return "credentials: none — the authors could not be read, so the broker withholds them";
  if (authors.length === 0) return "credentials: the owner's (SSH key, commit identity, forge tokens)";
  return (
    `credentials: none — tainted by ${describeTaint(authors)}. Only the owner can vouch for that ` +
    "text; call request_untaint to ask them"
  );
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
      "seconds the sandbox acts as them (their SSH key and commit identity) unless someone else " +
      "wrote text here; conversation_status says which. Only the owner can make it shared again, " +
      "from the UI.",
  );
}

/** request_untaint: asks the owner to vouch for tainting authors. */
export async function handleRequestUntaint(
  deps: ConversationToolsWiring,
  conversationId: string,
  args: { reason?: string },
): Promise<ToolResult> {
  const root = rootOf(deps, conversationId);
  if (!root || !deps.taint || !deps.requestUntaint) return text("Clearing a taint is not available here.", true);
  if (!root.owner) return text("This conversation has no owner, so nobody can clear its taint.", true);
  if ((await deps.currentVisibility(root.id)) !== "private") {
    return text(
      "This conversation is shared, so anyone who can see it may still prompt it and a clear would not " +
        "last. Make it private first (make_conversation_private), then ask.",
      true,
    );
  }
  const reason = args.reason?.trim();
  if (!reason) return text("Say why you need the owner's credentials in `reason`; the owner reads it.", true);
  const authors = await deps.taint(conversationId, root.owner).catch(() => undefined);
  if (!authors) return text("The conversation's authors could not be read; try again shortly.", true);
  if (authors.length === 0) return text("This conversation is not tainted; it already acts as its owner.");
  await deps.requestUntaint(conversationId, authors, reason);
  return text(
    `Asked the owner to clear the taint from ${describeTaint(authors)}. A card in the conversation ` +
      "shows them the authors and your reason. You'll get a message with their answer; don't ask again " +
      "in chat, and carry on with work that doesn't need their credentials meanwhile.",
  );
}
