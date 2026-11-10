/** "New session" split button: blank, or from context via caret. */

import { ChevronDown, GitFork, Plus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { FC, ReactNode } from "react";

import type { SessionSeedMode } from "./client.js";
import { cn } from "@/lib/utils";

/** Seeded-start menu label, shared with the /chat switcher. */
export const FROM_CONTEXT_LABEL = "New session from context";
export const FROM_CONTEXT_TITLE = "Start with a summary of this conversation";

export const menuItem =
  "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50";

export interface NewSessionButtonProps {
  /** Absent when no session can start, e.g. suspended. */
  onNew?: (seed: SessionSeedMode) => void;
  /** Without summary seeds this is a plain button. */
  summary: boolean;
  /** The blank-start half, styled by the caller. */
  children: ReactNode;
  /** Classes for the caret half. */
  caretClassName?: string;
  /** Accessible name for the caret. */
  caretLabel?: string;
  testId: string;
}

/** Blank half, plus a caret menu when summaries are offered. */
export const NewSessionButton: FC<NewSessionButtonProps> = ({ onNew, summary, children, caretClassName, caretLabel = "More ways to start a session", testId }) => {
  if (!summary) return <>{children}</>;
  return (
    <span className="flex shrink-0 items-center">
      {children}
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild disabled={!onNew}>
          <button
            type="button"
            data-testid={`${testId}-menu`}
            aria-label={caretLabel}
            className={cn("flex items-center justify-center disabled:pointer-events-none disabled:opacity-50", caretClassName)}
          >
            <ChevronDown className="size-3" aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-48 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
          >
            <DropdownMenu.Item data-testid={`${testId}-blank`} className={menuItem} onSelect={() => onNew?.("blank")}>
              <Plus className="size-3.5" aria-hidden />
              New session
            </DropdownMenu.Item>
            <DropdownMenu.Item
              data-testid={`${testId}-summary`}
              className={menuItem}
              title={FROM_CONTEXT_TITLE}
              onSelect={() => onNew?.("summary")}
            >
              <GitFork className="size-3.5" aria-hidden />
              {FROM_CONTEXT_LABEL}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
};
