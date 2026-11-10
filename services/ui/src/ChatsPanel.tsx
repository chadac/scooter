/**
 * Chats panel: the RightPanel section listing every chat in the open conversation's sandbox
 * (the conversation, the sessions people started and the subagents agents spawned), with
 * live status, click-to-open, Stop on a child, and New session.
 */

import { useState } from "react";
import { Plus } from "lucide-react";

import { ChildIcon } from "./ChildIcon.js";
import { memberState } from "./ChatSwitcher.js";
import { canStartSession, type FamilyMember } from "./family.js";
import { sessionStore, useCurrentUser, useSessions } from "./sessions.js";
import { removeSession, startSession } from "./sessionActions.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ChatsPanelViewProps {
  members: FamilyMember[];
  currentId: string | undefined;
  onOpen: (id: string) => void;
  onStop: (id: string) => void;
  /** Absent when no session can start, e.g. while the sandbox is suspended. */
  onNew?: () => void;
}

/** Pure view: New session, then the family, current chat marked. */
export function ChatsPanelView({ members, currentId, onOpen, onStop, onNew }: ChatsPanelViewProps) {
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        data-testid="chats-new-session"
        disabled={!onNew}
        title={onNew ? "A new chat over this sandbox's files" : "Resume this conversation to start a session"}
        onClick={() => onNew?.()}
      >
        <Plus aria-hidden />
        New session
      </Button>
      <ul className="flex flex-col gap-0.5" data-testid="chats-list">
        {members.map(({ session: s, depth }) => (
          <li
            key={s.id}
            data-testid="chat-row"
            data-kind={s.kind ?? "root"}
            data-current={s.id === currentId ? "true" : undefined}
            className={cn("group flex items-center gap-1.5 rounded-md py-1 pe-1 text-sm hover:bg-accent/50", s.id === currentId && "bg-accent/60")}
            style={{ paddingInlineStart: `${0.375 + depth * 0.75}rem` }}
          >
            <ChildIcon session={s} />
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7 min-w-0 flex-1 justify-start truncate px-1", s.id === currentId && "font-medium")}
              title={s.title}
              onClick={() => onOpen(s.id)}
              data-testid="chat-open"
            >
              {s.title}
            </Button>
            <span className="shrink-0 text-xs text-muted-foreground group-hover:hidden max-md:hidden">{memberState(s)}</span>
            {depth > 0 && s.status !== "ended" && (
              <Button
                variant="ghost"
                size="xs"
                data-testid="chat-stop"
                aria-label={`Stop ${s.title}`}
                onClick={() => onStop(s.id)}
                className="hidden shrink-0 text-muted-foreground group-hover:inline-flex max-md:inline-flex hover:bg-destructive/10 hover:text-destructive"
              >
                Stop
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Connected panel: the open conversation's family from the session store. */
export function ChatsPanel({ members }: { members: FamilyMember[] }) {
  const { currentId } = useSessions();
  const user = useCurrentUser();
  const root = members[0]?.session;
  const [error, setError] = useState<string>();
  return (
    <>
      <ChatsPanelView
        members={members}
        currentId={currentId}
        onOpen={(id) => sessionStore.switchTo(id)}
        // Stop ends and deletes the child, so it leaves the listing.
        onStop={(id) => {
          const child = members.find((m) => m.session.id === id)?.session;
          if (child) void removeSession(child);
        }}
        onNew={
          canStartSession(root, user)
            ? () => {
                setError(undefined);
                void startSession(root).then((err) => err && setError(`Couldn't start a session: ${err}`));
              }
            : undefined
        }
      />
      {error && (
        <p role="alert" data-testid="chats-error" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
