/** The "forked from" card atop a seeded session. */

import { useState, type FC } from "react";
import { ChevronDown, ChevronUp, GitFork } from "lucide-react";

import { useConversationInterrupts } from "@/src/RuntimeProvider";
import { sessionStore, useSessions } from "@/src/sessions";

export const SessionSeedCard: FC = () => {
  const { sessionSeed: seed } = useConversationInterrupts();
  const { sessions } = useSessions();
  const [open, setOpen] = useState(false);
  if (!seed) return null;
  // The parent's row, if listed, so its title opens it.
  const parent = sessions.find((s) => s.serverId === seed.parentId || s.id === seed.parentId);
  const title = parent?.title ?? seed.parentTitle ?? "the parent conversation";
  return (
    <div data-testid="session-seed-card" className="mx-auto mb-6 w-full max-w-2xl rounded-lg border bg-card text-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <GitFork aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          Forked from{" "}
          {parent ? (
            <button
              type="button"
              data-testid="session-seed-parent"
              className="font-medium underline-offset-2 hover:underline"
              onClick={() => sessionStore.switchTo(parent.id)}
            >
              {title}
            </button>
          ) : (
            <span className="font-medium">{title}</span>
          )}
          <span className="text-muted-foreground">
            {" "}
            · summary of {seed.summarizedTurns} {seed.summarizedTurns === 1 ? "turn" : "turns"}
          </span>
        </span>
        <button
          type="button"
          data-testid="session-seed-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {open ? "Hide summary" : "Show summary"}
          {open ? <ChevronUp aria-hidden className="size-3" /> : <ChevronDown aria-hidden className="size-3" />}
        </button>
      </div>
      {open && (
        <div data-testid="session-seed-body" className="whitespace-pre-wrap break-words border-t px-3 py-2 text-[13px] text-muted-foreground">
          {seed.text}
        </div>
      )}
    </div>
  );
};
