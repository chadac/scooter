/**
 * Subagents panel — the RightPanel tab (on a parent conversation) that lists the
 * subagents spawned in THIS conversation: title, live status, click-to-open, and
 * a cancel button. Subagents are full conversations sharing the parent's pod (see
 * todo/docs/SUBAGENTS.md); their live status comes from the same session store the
 * sidebar uses (server-sourced, live via /conversations/events).
 */

import { sessionStore, useSessions, type Session } from "./sessions.js";

/** The subagents (children) of `parentId`, from the session store. */
export function subagentsOf(sessions: Session[], parentId: string | undefined): Session[] {
  if (!parentId) return [];
  return sessions.filter((s) => s.parentId === parentId);
}

const STATUS_DOT: Record<string, string> = {
  running: "bg-green-500 animate-pulse",
  suspended: "bg-amber-500",
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
          <button
            className="min-w-0 flex-1 truncate text-left"
            title={s.title}
            onClick={() => onOpen(s.id)}
            data-testid="subagent-open"
          >
            {s.title}
          </button>
          {s.status === "running" && (
            <button
              data-testid="subagent-cancel"
              aria-label={`Cancel ${s.title}`}
              onClick={() => onCancel(s.id)}
              className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
            >
              Stop
            </button>
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
      // Cancel routes through the agent's cancel path — for now, switch to the
      // child + let its Stop button drive the run cancel (the subagent is a full
      // conversation with its own Stop). A dedicated cancel_subagent call is a
      // follow-up once the panel has the conversation's baseUrl wired.
      onCancel={(id) => sessionStore.switchTo(id)}
    />
  );
}
