/**
 * The open conversation's title in the top header, plus (when `actions`) its star / rename /
 * delete controls. These live here rather than on the sidebar rows: on mobile the sidebar is a
 * drawer, and hover-revealed tiles on a row are easy to hit while selecting a conversation.
 */

import { useState } from "react";
import { Lock, LockOpen, Pencil, Star, StarFilled, Trash2 } from "@/icons";
import { flushSync } from "react-dom";

import { displayTitle } from "./pageTitle.js";
import { sessionStore, useSessions, type Session } from "./sessions.js";
import {
  canChangeVisibility,
  commitRename,
  isServerBacked,
  removeSession,
  toggleStar,
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

function Actions({ session: s }: { session: Session }) {
  const { currentUser, currentUserAnonymous } = useSessions();
  const backed = isServerBacked(s);
  const isPrivate = s.visibility === "private";
  // Rename is local-first, so a never-sent conversation can still be named.
  const openRename = () => flushSync(() => sessionStore.setEditing(s.id));
  const remove = () => {
    if (!window.confirm(confirmDeleteMessage(s, backed))) return;
    void removeSession(s);
  };
  return (
    <div data-testid="session-actions" className="flex shrink-0 items-center gap-0.5">
      {/* Star is top-level only; subagents are not independently retained. */}
      {!s.parentId && (
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="session-star"
          aria-label={s.starred ? `Unstar ${s.title}` : `Star ${s.title}`}
          aria-pressed={s.starred ? true : false}
          // Starred is server-owned, so an unsent conversation cannot be starred.
          disabled={!backed}
          title={backed ? (s.starred ? "Unstar" : "Star") : "Send a message first — an unsent conversation can't be starred"}
          onClick={() => void toggleStar(s)}
          className={cn(s.starred ? "text-warning" : "text-muted-foreground hover:text-warning")}
        >
          {s.starred ? <StarFilled /> : <Star />}
        </Button>
      )}
      {/* Only the owner of a top-level conversation; subagents follow their parent. */}
      {canChangeVisibility(s, currentUser, currentUserAnonymous) && (
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
