/** The expand_workspace MCP tool: grow /workspace without a restart. */

import type { ToolResult } from "./mcpServer.js";
import {
  checkGrowth,
  growAndWait,
  type GrowOptions,
  type WorkspaceExpandRequest,
  type WorkspaceLimits,
  type WorkspaceVolume,
  type WorkspaceVolumeClient,
} from "../session/workspaceVolume.js";

/** What expand_workspace needs from the agent-host. */
export interface WorkspaceToolsWiring {
  limits: WorkspaceLimits;
  /** Keyed by conversation id; the wiring maps it to the claim. */
  volume: WorkspaceVolumeClient;
  /** Raise an approval card for a growth above the soft limit. */
  requestApproval(conversationId: string, req: WorkspaceExpandRequest): Promise<void>;
  grow?: GrowOptions;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

/** The workspace line of show_sandbox_resources. */
export function workspaceLine(limits: WorkspaceLimits, vol: WorkspaceVolume | undefined): string {
  if (!vol) return "";
  const size = vol.capacity ?? vol.requested;
  const resizing = vol.capacity && vol.capacity !== vol.requested ? ` (resizing to ${vol.requested})` : "";
  const grow =
    limits.autoMax === limits.max
      ? `up to ${limits.max}`
      : `up to ${limits.autoMax} on your own, up to ${limits.max} with the owner's approval`;
  return `- workspace: ${size}${resizing}; grow it with expand_workspace, ${grow}\n`;
}

/** Grows now, or asks the owner above the soft limit. */
export async function handleExpandWorkspace(
  deps: WorkspaceToolsWiring,
  conversationId: string,
  args: { size?: string; reason?: string },
): Promise<ToolResult> {
  const size = args.size?.trim() ?? "";
  const reason = args.reason?.trim();
  if (!reason) return text("Say why you need the space in `reason`; the owner may read it.", true);
  const check = checkGrowth(deps.limits, await deps.volume.getWorkspace(conversationId), size);
  if (check.kind === "refused") return text(check.reason, true);
  if (check.kind === "approval") {
    await deps.requestApproval(conversationId, { from: check.from, size, reason });
    return text(
      `${size} is above the ${deps.limits.autoMax} you may use without asking, so a card asks the owner. ` +
        "You'll get a message with their answer; don't ask again in chat, and carry on meanwhile.",
    );
  }
  const out = await growAndWait(deps.volume, conversationId, size, deps.grow);
  return text(out.text, !out.ok);
}
