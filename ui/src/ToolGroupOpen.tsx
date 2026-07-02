/**
 * ToolGroup override — render consecutive tool calls EXPANDED by default, instead
 * of collapsed behind a "N tool calls" disclosure. So the provider message cards
 * (slack/github/…) and the shell commands are visible top-level, not hidden.
 *
 * Wired in App.tsx: <Thread components={{ ToolGroup: ToolGroupOpen, ... }} />.
 */

import type { PropsWithChildren } from "react";

import {
  ToolGroupRoot,
  ToolGroupTrigger,
  ToolGroupContent,
} from "@/components/assistant-ui/tool-group";
import type { ThreadGroupPart } from "@/components/assistant-ui/thread";

// The `group` part carries indices + status; we only need to render its children
// open, with the count trigger still available to collapse.
export function ToolGroupOpen({ group, children }: PropsWithChildren<{ group: ThreadGroupPart }>) {
  return (
    <ToolGroupRoot variant="ghost" defaultOpen>
      <ToolGroupTrigger count={group.indices.length} active={group.status.type === "running"} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}
