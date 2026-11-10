/**
 * The embedded chat's switcher: its header title opens a menu of the sandbox's chats (the
 * conversation, its sessions and its subagents) to switch between or start one, in place.
 */

import { ChevronDown, Plus, TriangleAlert } from "lucide-react";
import { DropdownMenu } from "radix-ui";

import { ChildIcon } from "./ChildIcon.js";
import { familyActivity, type FamilyMember } from "./family.js";
import { turnDot, type Session } from "./sessions.js";
import { cn } from "@/lib/utils";

/** A member's state in words, for the menu's right column. */
export function memberState(s: Session): string {
  const dot = turnDot(s);
  if (dot === "question") return "waiting on you";
  if (dot === "active") return "working";
  if (dot === "failed") return "failed";
  if (s.status === "suspended") return "suspended";
  if (s.status === "ended") return "ended";
  return "idle";
}

/** The member `step` places from `activeId`, wrapping around. */
export function stepMember(members: FamilyMember[], activeId: string, step: number): string | undefined {
  if (members.length === 0) return undefined;
  const i = members.findIndex((m) => m.session.id === activeId);
  return members[(((i < 0 ? 0 : i) + step) % members.length + members.length) % members.length].session.id;
}

const item =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none select-none " +
  "data-[highlighted]:bg-accent data-[disabled]:opacity-50";

export interface ChatSwitcherProps {
  members: FamilyMember[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Absent when no session can start, e.g. while the sandbox is suspended. */
  onNew?: () => void;
}

export function ChatSwitcher({ members, activeId, onSelect, onNew }: ChatSwitcherProps) {
  const active = members.find((m) => m.session.id === activeId)?.session;
  const { running, awaiting } = familyActivity(members);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="chat-switcher"
          aria-label="Switch chat"
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent focus-visible:outline-2"
        >
          {active && <ChildIcon session={active} />}
          <span data-testid="chat-switcher-title" className="truncate font-medium">
            {active?.title ?? "Chat"}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {members.length > 1 && (
            <span data-testid="chat-switcher-count" className="shrink-0 text-xs text-muted-foreground" title={`${members.length} chats in this sandbox`}>
              {members.length}
            </span>
          )}
          {running > 0 && (
            <span data-testid="chat-switcher-running" className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title={`${running} working`}>
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
              {running}
            </span>
          )}
          {awaiting > 0 && (
            <span
              data-testid="chat-switcher-awaiting"
              className="flex shrink-0 items-center gap-0.5 text-xs text-status-question"
              title={`${awaiting} waiting on you`}
            >
              <TriangleAlert className="size-3" aria-hidden />
              {awaiting}
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          data-testid="chat-switcher-menu"
          className="z-50 max-h-[70vh] w-[min(22rem,calc(100vw-1rem))] overflow-y-auto rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
        >
          {members.map(({ session: s, depth }) => (
            <DropdownMenu.Item
              key={s.id}
              data-testid="chat-switcher-item"
              data-conversation-id={s.serverId ?? s.id}
              data-active={s.id === activeId ? "true" : undefined}
              onSelect={() => onSelect(s.id)}
              className={cn(item, s.id === activeId && "font-medium")}
              style={{ paddingInlineStart: `${0.5 + depth * 0.875}rem` }}
            >
              <ChildIcon session={s} />
              <span className="min-w-0 flex-1 truncate" title={s.title}>
                {s.title}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{memberState(s)}</span>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            data-testid="chat-switcher-new"
            disabled={!onNew}
            onSelect={() => onNew?.()}
            className={item}
            title={onNew ? "Alt+N" : "Resume this conversation to start a session"}
          >
            <Plus className="size-3.5" aria-hidden />
            New session
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
