/**
 * ToolGroup override that renders consecutive tool calls expanded by default, so
 * the provider message cards and shell commands are visible top-level. Wired in
 * App.tsx via <Thread components={{ ToolGroup: ToolGroupOpen }} />.
 *
 * A group of one renders its card bare: a "1 tool call" line over a single card said
 * nothing the card doesn't, and cost a row and an indent. The count trigger stays for
 * two or more, where it folds the run.
 */

import type { PropsWithChildren } from "react";

import {
  ToolGroupRoot,
  ToolGroupTrigger,
  ToolGroupContent,
} from "@/components/assistant-ui/tool-group";
import type { ThreadGroupPart } from "@/components/assistant-ui/thread";

export function ToolGroupOpen({ group, children }: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const count = group.indices.length;
  if (count === 1) {
    return <div data-slot="tool-group-single">{children}</div>;
  }
  // Render the group's children open, with the count trigger still available to collapse.
  return (
    <ToolGroupRoot variant="ghost" defaultOpen>
      <ToolGroupTrigger count={count} active={group.status.type === "running"} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}
