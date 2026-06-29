/**
 * Session selector — the left sidebar. Lists conversations with titles, the
 * current one highlighted, plus a "new conversation" button.
 *
 * testids match the e2e specs: session-list, session-item, session-title,
 * new-session.
 */

import { sessionStore, useSessions } from "./sessions.js";
import { LinkedResources } from "./LinkedResources.js";
import { SourceBadge } from "./sourceIcon.js";

export function Sidebar() {
  const { sessions, currentId } = useSessions();

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-muted/30">
      <div className="p-3">
        <button
          data-testid="new-session"
          onClick={() => sessionStore.newSession()}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm hover:bg-accent"
        >
          + New conversation
        </button>
      </div>
      <nav data-testid="session-list" className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            data-testid="session-item"
            data-active={s.id === currentId}
            className={
              "group mb-1 flex items-center gap-1 rounded-md pe-1 text-sm " +
              (s.id === currentId ? "bg-accent" : "hover:bg-accent/50")
            }
          >
            <button
              onClick={() => sessionStore.switchTo(s.id)}
              className={
                "min-w-0 flex-1 truncate px-3 py-2 text-left " +
                (s.id === currentId ? "font-medium" : "")
              }
              title={s.title}
            >
              <span data-testid="session-title">{s.title}</span>
            </button>
            {/* Provider badges for any linked external resources (GitHub/Slack/…). */}
            {s.sources && s.sources.length > 0 && (
              <span className="flex shrink-0 items-center gap-0.5">
                {s.sources.map((src) => (
                  <SourceBadge key={src} source={src} />
                ))}
              </span>
            )}
            <button
              data-testid="session-delete"
              aria-label={`Delete ${s.title}`}
              onClick={() => sessionStore.deleteSession(s.id)}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
            >
              ✕
            </button>
          </div>
        ))}
      </nav>
      {/* The current conversation's external resources (GitHub PR / Slack thread
          / …), collapsible. Hidden when there are none. */}
      <LinkedResources />
    </aside>
  );
}
