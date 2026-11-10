/**
 * Subagents panel: the RightPanel tab on a parent conversation that lists the
 * subagents spawned in this conversation with title, live status, click-to-open
 * and a Stop button that ends and deletes it. Subagents are full conversations sharing the parent's pod;
 * their live status comes from the same session store the sidebar uses.
 */

import { sessionStore, useSessions, serverKeyOf, type Session } from "./sessions.js";
import { Button } from "@/components/ui/button";
import { removeSession } from "./sessionActions.js";

/** The subagents of `parentId`, a local store key that is resolved to its server id before matching against each child's server-side `parentId`. */
export function subagentsOf(sessions: Session[], parentId: string | undefined): Session[] {
  if (!parentId) return [];
  const current = sessions.find((s) => s.id === parentId);
  const serverId = serverKeyOf(current ?? { id: parentId });
  return sessions.filter((s) => s.parentId === serverId);
}

const STATUS_DOT: Record<string, string> = {
  running: "bg-success animate-pulse",
  suspended: "bg-warning",
  failed: "bg-destructive",
  ended: "bg-muted-foreground/40",
};

export interface SubagentsPanelViewProps {
  subagents: Session[];
  onOpen: (id: string) => void;
  onCancel: (id: string) => void;
}

/** Pure view — the list, or an empty hint. */
export function SubagentsPanelView({ subagents, onOpen, onCancel }: SubagentsPanelViewProps) {
  if (subagents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="subagents-empty">
        No subagents in this conversation. The agent can spawn one to delegate work.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1" data-testid="subagents-list">
      {subagents.map((s) => (
        <li
          key={s.id}
          data-testid="subagent-row"
          className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
        >
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[s.status ?? "ended"] ?? STATUS_DOT.ended}`} aria-hidden />
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start truncate px-0"
            title={s.title}
            onClick={() => onOpen(s.id)}
            data-testid="subagent-open"
          >
            {s.title}
          </Button>
          {s.status !== "ended" && (
            <Button
              variant="ghost"
              size="xs"
              data-testid="subagent-cancel"
              aria-label={`Stop ${s.title}`}
              onClick={() => onCancel(s.id)}
              className="shrink-0 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
            >
              Stop
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Connected panel — reads the current conversation's children from the store. */
export function SubagentsPanel() {
  const { sessions, currentId } = useSessions();
  const subagents = subagentsOf(sessions, currentId);
  return (
    <SubagentsPanelView
      subagents={subagents}
      onOpen={(id) => sessionStore.switchTo(id)}
      // Stop ends and deletes the child, so it leaves the listing.
      onCancel={(id) => {
        const child = subagents.find((s) => s.id === id);
        if (child) void removeSession(child);
      }}
    />
  );
}
