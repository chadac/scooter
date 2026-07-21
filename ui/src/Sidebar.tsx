/**
 * Session selector — the left sidebar. Lists conversations with titles, the
 * current one highlighted, plus a "new conversation" button.
 *
 * testids match the e2e specs: session-list, session-item, session-title,
 * new-session.
 */

import {
  sessionStore,
  useSessions,
  filteredSessions,
  sessionLabel,
  LINK_PROVIDERS,
  type LinkProvider,
} from "./sessions.js";
import { LinkedResources } from "./LinkedResources.js";
import { SourceBadge } from "./sourceIcon.js";

const PROVIDER_LABEL: Record<LinkProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  slack: "Slack",
  jira: "JIRA",
  none: "None",
};

export function Sidebar() {
  const state = useSessions();
  const { currentId, scope, query, providerFilter, labelMode } = state;
  const sessions = filteredSessions(state);
  const chips: LinkProvider[] = [...LINK_PROVIDERS, "none"];

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
      {/* Keyword search over the title + linked-resource names. */}
      <div className="px-3 pb-2">
        <input
          data-testid="session-search"
          type="search"
          value={query}
          onChange={(e) => sessionStore.setQuery(e.target.value)}
          placeholder="Search chats…"
          aria-label="Search conversations"
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground"
        />
      </div>
      {/* Mine / All view filter (conversations are public; this is just a view). */}
      <div data-testid="scope-toggle" className="flex gap-1 px-3 pb-1 text-xs">
        {(["mine", "all"] as const).map((s) => (
          <button
            key={s}
            data-testid={`scope-${s}`}
            data-active={scope === s}
            onClick={() => sessionStore.setScope(s)}
            className={
              "flex-1 rounded px-2 py-1 capitalize " +
              (scope === s ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50")
            }
          >
            {s}
          </button>
        ))}
      </div>
      {/* Titles / Links label mode — show the conversation title or the linked
          PR/MR/thread name. */}
      <div data-testid="label-toggle" className="flex gap-1 px-3 pb-1 text-xs">
        {(["title", "link"] as const).map((m) => (
          <button
            key={m}
            data-testid={`label-${m}`}
            data-active={labelMode === m}
            onClick={() => sessionStore.setLabelMode(m)}
            className={
              "flex-1 rounded px-2 py-1 " +
              (labelMode === m ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50")
            }
          >
            {m === "title" ? "Titles" : "Links"}
          </button>
        ))}
      </div>
      {/* Provider filter chips (multi-select) — show only chats linked to any
          selected provider ("None" = unlinked). */}
      <div data-testid="provider-filter" className="flex flex-wrap gap-1 px-3 pb-2 pt-1 text-xs">
        {chips.map((p) => {
          const active = providerFilter.includes(p);
          return (
            <button
              key={p}
              data-testid={`provider-${p}`}
              data-active={active}
              aria-pressed={active}
              onClick={() => sessionStore.toggleProvider(p)}
              className={
                "rounded-full border px-2 py-0.5 " +
                (active
                  ? "border-foreground bg-foreground text-background"
                  : "text-muted-foreground hover:bg-accent/50")
              }
            >
              {PROVIDER_LABEL[p]}
            </button>
          );
        })}
      </div>
      <nav data-testid="session-list" className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p data-testid="session-empty" className="px-3 py-2 text-sm text-muted-foreground">
            No chats match.
          </p>
        )}
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
              <span data-testid="session-title">{sessionLabel(s, labelMode)}</span>
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
