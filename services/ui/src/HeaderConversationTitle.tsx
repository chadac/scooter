/**
 * The open conversation's title in the top header, plus (when `actions`) its star / rename /
 * delete controls. These live here rather than on the sidebar rows: on mobile the sidebar is a
 * drawer, and hover-revealed tiles on a row are easy to hit while selecting a conversation.
 */

import { useState, type ReactNode } from "react";
import { Check, EllipsisVertical, FolderInput, FolderPlus, Lock, LockOpen, Pencil, Star, Trash2 } from "lucide-react";
import { DropdownMenu, Popover } from "radix-ui";
import { flushSync } from "react-dom";

import { FolderGlyph } from "./FolderGlyph.js";
import { folderOf, folderStore, moveTo, STARRED, useFolders } from "./folders.js";
import { displayTitle } from "./pageTitle.js";
import { sessionStore, useSessions, type Session } from "./sessions.js";
import {
  canChangeVisibility,
  commitRename,
  isServerBacked,
  removeSession,
  toggleVisibility,
} from "./sessionActions.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Whether a blurred rename input stays open: only focus moving WITHIN the rename control keeps
 *  it, since an input left open with nothing focused strands the rename lock. Why: PR #783. */
export const renameStaysOpen = (hasNextTarget: boolean, nextIsInside: boolean): boolean =>
  hasNextTarget && nextIsInside;

export function confirmDeleteMessage(s: Pick<Session, "title" | "starred">, backed = true): string {
  // A never-sent conversation has no sandbox, so don't threaten to destroy one.
  if (!backed) return `Delete "${s.title}"? It was never sent, so there is nothing on the server to remove.`;
  return s.starred
    ? `"${s.title}" is starred. Deleting destroys its sandbox and data permanently. Delete anyway?`
    : `Delete "${s.title}"? This destroys its sandbox and data permanently.`;
}

function RenameInput({ session: s }: { session: Session }) {
  const [draft, setDraft] = useState(s.title);
  const commit = () => {
    sessionStore.clearEditing(s.id);
    void commitRename(s, draft);
  };
  return (
    <input
      data-testid="session-rename-input"
      aria-label="Conversation title"
      autoFocus
      value={draft}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        const box = e.currentTarget.closest('[data-testid="header-conversation"]');
        const hasNextTarget = e.relatedTarget instanceof Node;
        const nextIsInside = hasNextTarget && (box?.contains(e.relatedTarget) ?? false);
        if (!renameStaysOpen(hasNextTarget, nextIsInside)) commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") sessionStore.clearEditing(s.id);
      }}
      className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-[13.5px] desk:max-w-[32rem]"
    />
  );
}

const menuItem =
  "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground";

/** Star / move / visibility / rename / delete: inline buttons on desktop, a "⋯" menu on phones. */
function Actions({ session: s }: { session: Session }) {
  const { currentUser, currentUserAnonymous } = useSessions();
  const [moving, setMoving] = useState(false);
  const backed = isServerBacked(s);
  const isPrivate = s.visibility === "private";
  // Star and move are top-level only; subagents are not independently retained.
  const starrable = !s.parentId;
  const movable = starrable && backed;
  // Only the owner of a top-level conversation; subagents follow their parent.
  const canShare = canChangeVisibility(s, currentUser, currentUserAnonymous);
  const star = () => void moveTo(s, s.starred ? null : STARRED);
  // Rename is local-first, so a never-sent conversation can still be named.
  const openRename = () => flushSync(() => sessionStore.setEditing(s.id));
  const remove = () => {
    if (!window.confirm(confirmDeleteMessage(s, backed))) return;
    void removeSession(s);
  };
  const menu = (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="session-menu"
          aria-label={`Actions for ${s.title}`}
          title="Conversation actions"
          className="text-muted-foreground"
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-44 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
        >
          {starrable && (
            // Starred is server-owned, so an unsent conversation cannot be starred.
            <DropdownMenu.Item data-testid="session-menu-star" disabled={!backed} onSelect={star} className={menuItem}>
              <Star fill={s.starred ? "currentColor" : "none"} className={cn(s.starred && "text-warning!")} />
              {s.starred ? "Unstar" : "Star"}
            </DropdownMenu.Item>
          )}
          {movable && (
            // Deferred so the menu has closed and returned focus before the picker takes it.
            <DropdownMenu.Item data-testid="session-menu-move" onSelect={() => setTimeout(() => setMoving(true))} className={menuItem}>
              <FolderInput />
              Move to…
            </DropdownMenu.Item>
          )}
          {canShare && (
            <DropdownMenu.Item data-testid="session-menu-visibility" onSelect={() => void toggleVisibility(s)} className={menuItem}>
              {isPrivate ? <LockOpen /> : <Lock />}
              {isPrivate ? "Make shared" : "Make private"}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item data-testid="session-menu-rename" onSelect={() => setTimeout(openRename)} className={menuItem}>
            <Pencil />
            Rename
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            data-testid="session-menu-delete"
            onSelect={() => setTimeout(remove)}
            className={cn(menuItem, "text-destructive data-[highlighted]:bg-destructive/10 [&_svg]:text-destructive")}
          >
            <Trash2 />
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
  return (
    <>
      <div data-testid="session-actions" className="hidden shrink-0 items-center gap-0.5 desk:flex">
        {starrable && (
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="session-star"
            aria-label={s.starred ? `Unstar ${s.title}` : `Star ${s.title}`}
            aria-pressed={s.starred ? true : false}
            disabled={!backed}
            title={backed ? (s.starred ? "Unstar" : "Star") : "Send a message first — an unsent conversation can't be starred"}
            onClick={star}
            className={cn(s.starred ? "text-warning" : "text-muted-foreground hover:text-warning")}
          >
            <Star fill={s.starred ? "currentColor" : "none"} />
          </Button>
        )}
        {movable && <MoveTo session={s} />}
        {canShare && (
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="session-visibility"
            aria-label={isPrivate ? `Make ${s.title} shared` : `Make ${s.title} private`}
            aria-pressed={isPrivate}
            title={
              isPrivate
                ? "Private: only you can see it. Click to share"
                : "Shared: anyone signed in can see it. Click to make private"
            }
            onClick={() => void toggleVisibility(s)}
            className="text-muted-foreground"
          >
            {isPrivate ? <Lock /> : <LockOpen />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="session-rename"
          aria-label={`Rename ${s.title}`}
          title="Rename"
          onClick={openRename}
          className="text-muted-foreground"
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="session-delete"
          aria-label={`Delete ${s.title}`}
          title="Delete"
          onClick={remove}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </div>
      {/* A phone header has no room for five buttons, so they fold into one menu. */}
      <div className="flex shrink-0 desk:hidden">
        {movable ? <MoveTo session={s} open={moving} onOpenChange={setMoving} anchor={menu} /> : menu}
      </div>
    </>
  );
}

/** The conversation's title beside the wordmark; absent when unnamed and not yet on the server. */
export function HeaderConversationTitle({ actions = false }: { actions?: boolean }) {
  const { sessions, currentId, editingId } = useSessions();
  const s = sessions.find((x) => x.id === currentId);
  const title = displayTitle(s?.title);
  if (!s || (!title && !(actions && isServerBacked(s)))) return null;
  const editing = actions && editingId === s.id;
  return (
    <div data-testid="header-conversation" className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="text-muted-foreground/50" aria-hidden>/</span>
      {editing ? (
        // Keyed so reopening starts from the current title, not a stale draft.
        <RenameInput key={s.id} session={s} />
      ) : (
        title && (
          <span
            data-testid="header-conversation-title"
            title={title}
            className="min-w-0 truncate text-[13.5px] text-muted-foreground desk:max-w-[32rem]"
          >
            {title}
          </span>
        )
      )}
      {actions && !editing && <Actions session={s} />}
    </div>
  );
}

/** "Move to…": Starred, a folder, a new folder, or Recent. With `anchor`, the caller opens it. */
function MoveTo({
  session: s,
  open: openProp,
  onOpenChange,
  anchor,
}: {
  session: Session;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchor?: ReactNode;
}) {
  const { folders } = useFolders();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const [filter, setFilter] = useState("");
  const current = folderOf(s);
  const pick = (id: string | null) => {
    void moveTo(s, id);
    setOpen(false);
    setFilter("");
  };
  const pickNew = async () => {
    const name = filter.trim();
    setOpen(false);
    setFilter("");
    const id = await folderStore.create(name);
    if (id) await moveTo(s, id);
  };
  const options = folders.filter((f) =>
    f.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const exact = folders.some((f) => f.name.toLowerCase() === filter.trim().toLowerCase());
  const item = "flex w-full items-center gap-2 rounded px-2 py-1 text-start text-sm hover:bg-accent";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {anchor ? (
        <Popover.Anchor className="flex">{anchor}</Popover.Anchor>
      ) : (
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="session-move"
            aria-label={`Move ${s.title} to a folder`}
            title="Move to…"
            className="text-muted-foreground"
          >
            <FolderInput />
          </Button>
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-60 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (options[0]) pick(options[0].id);
              else if (filter.trim()) void pickNew();
            }}
            placeholder="Move to…"
            aria-label="Filter folders"
            className="mb-1 h-7 w-full rounded border border-input bg-background px-2 text-sm"
          />
          {options.map((f) => (
            <button key={f.id} type="button" className={item} onClick={() => pick(f.id)}>
              <FolderGlyph starred={f.id === STARRED} icon={f.icon} className={f.id === STARRED ? undefined : "text-muted-foreground"} />
              <span className="flex-1 truncate">{f.name}</span>
              {current === f.id && <Check className="size-3.5" />}
            </button>
          ))}
          {filter.trim() && !exact && (
            <button type="button" className={item} onClick={() => void pickNew()}>
              <FolderPlus className="size-3.5 text-muted-foreground" />
              <span className="truncate">New folder “{filter.trim()}”</span>
            </button>
          )}
          {current && (
            <>
              <div className="my-1 h-px bg-border" />
              <button type="button" className={cn(item, "text-muted-foreground")} onClick={() => pick(null)}>
                Remove from {current === STARRED ? "Starred" : "folder"}
              </button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
