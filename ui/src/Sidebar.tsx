/**
 * Session selector — the left sidebar. Lists conversations with titles, the
 * current one highlighted, plus a "new conversation" button.
 *
 * testids match the e2e specs: session-list, session-item, session-title,
 * new-session.
 */

import { useState } from "react";

import {
  sessionStore,
  useSessions,
  filteredSessions,
  sessionLabel,
  LINK_PROVIDERS,
  type LabelMode,
} from "./sessions.js";
import { LinkedResources } from "./LinkedResources.js";
import { SourceBadge, sourceLabel, TitleBadge } from "./sourceIcon.js";

/** A small "?" affordance with an explanatory tooltip (native title + aria-label,
 *  matching the sidebar's lightweight style). */
function InfoTip({ text }: { text: string }) {
  return (
    <span
      data-testid="info-tip"
      role="img"
      title={text}
      aria-label={text}
      tabIndex={0}
      className="inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border text-[9px] leading-none text-muted-foreground"
    >
      ?
    </span>
  );
}

export function Sidebar() {
  const state = useSessions();
  const { currentId, scope, query, providerFilter, labelMode } = state;
  const sessions = filteredSessions(state);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // How many advanced filters are "active" (non-default) — a badge on the toggle so
  // the user knows a filter is narrowing the list even when the panel is collapsed.
  const activeFilters =
    (scope === "all" ? 1 : 0) + providerFilter.length + (labelMode !== "title" ? 1 : 0);

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

      {/* Advanced filters — a collapsible below search holding Scope (Mine/All),
          the linked-provider filter chips, and the Show (label-mode) control. */}
      <div className="px-3 pb-2">
        <button
          type="button"
          data-testid="filters-toggle"
          data-open={filtersOpen}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <span className={"transition-transform " + (filtersOpen ? "rotate-90" : "")}>›</span>
          <span className="font-medium">Advanced</span>
          {activeFilters > 0 && (
            <span
              data-testid="filters-active-count"
              className="ml-auto inline-flex min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] text-background"
            >
              {activeFilters}
            </span>
          )}
        </button>

        {filtersOpen && (
          <div data-testid="filters-panel" className="mt-1 flex flex-col gap-2 rounded-md border bg-background/60 p-2 text-xs">
            {/* Default — Mine / All (conversations are public; this is just a view;
                Mine is the default). */}
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-muted-foreground">Default</span>
              <div data-testid="scope-toggle" className="flex flex-1 gap-1">
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
            </div>

            {/* Only — provider icon chips (multi-select) that FILTER the list: any
                selected -> show only chats linked to one of them; none -> show all. */}
            <div className="flex items-center gap-2">
              <span className="flex w-12 shrink-0 items-center gap-1 text-muted-foreground">
                Only
                <InfoTip text="Only show conversations linked to the selected provider(s)." />
              </span>
              <div data-testid="provider-filter" className="flex flex-1 flex-wrap gap-1.5">
                {LINK_PROVIDERS.map((p) => {
                  const active = providerFilter.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      data-testid={`provider-${p}`}
                      data-active={active}
                      aria-pressed={active}
                      aria-label={`Filter by ${sourceLabel(p)}`}
                      title={`Filter by ${sourceLabel(p)}`}
                      onClick={() => sessionStore.toggleProvider(p)}
                      className={
                        "flex items-center justify-center rounded-md border p-1.5 " +
                        (active
                          ? "border-foreground bg-accent"
                          : "border-transparent opacity-40 hover:opacity-100 hover:bg-accent/50")
                      }
                    >
                      <SourceBadge source={p} size={15} />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Show — a segmented icon row picking WHAT EACH ROW DISPLAYS: the Scooter
                mark = the conversation TITLE, or a provider = that provider's linked
                resource name (rows without such a link fall back to the title). */}
            <div className="flex items-center gap-2">
              <span className="flex w-12 shrink-0 items-center gap-1 text-muted-foreground">
                Show
                <InfoTip text="Sets what each row displays — the conversation title (Scooter), or a provider's linked-resource name (falling back to the title when there's no such link)." />
              </span>
              <div
                data-testid="label-mode"
                role="radiogroup"
                aria-label="What each row shows"
                className="flex flex-1 gap-1 rounded-md border p-0.5"
              >
                {(["title", ...LINK_PROVIDERS] as const).map((m) => {
                  const active = labelMode === m;
                  const lbl = m === "title" ? "Conversation title" : `${sourceLabel(m)} link name`;
                  return (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-testid={`label-${m}`}
                      data-active={active}
                      aria-label={lbl}
                      title={lbl}
                      onClick={() => sessionStore.setLabelMode(m as LabelMode)}
                      className={
                        "flex flex-1 items-center justify-center rounded p-1 " +
                        (active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50")
                      }
                    >
                      {m === "title" ? <TitleBadge size={15} /> : <SourceBadge source={m} size={15} />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
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
