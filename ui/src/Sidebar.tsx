/**
 * Session selector — the left sidebar. Lists conversations with titles, the
 * current one highlighted, plus a "new conversation" button.
 *
 * testids match the e2e specs: session-list, session-item, session-title,
 * new-session.
 */

import { memo, useState } from "react";
import { flushSync } from "react-dom";

import {
  sessionStore,
  useSessions,
  filteredSessions,
  nestSubagents,
  sessionLabel,
  LINK_PROVIDERS,
  type LabelMode,
} from "./sessions.js";
import { LinkedResources } from "./LinkedResources.js";
import { SourceBadge, sourceLabel, TitleBadge } from "./sourceIcon.js";
import { agentHostConfig } from "./config.js";
import { renameConversation, setConversationStarred, deleteConversation } from "./client.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

/** One conversation row: select, inline rename (double-click the title), star
 *  toggle, and delete-with-confirm (a stronger confirm when starred).
 *
 *  memo()'d: the 10s merge poll re-renders <Sidebar>, but a row whose Session
 *  reference + primitive props are unchanged (mergeFromServer reuses the object when
 *  nothing changed — see sameSession) skips re-render entirely. That's what keeps an
 *  in-progress interaction (an open rename input, a hover) from being disrupted by a
 *  background poll (the sidebar flake family). */
const SessionRow = memo(function SessionRow({
  session: s,
  depth,
  childCount,
  active,
  editing,
  labelMode,
}: {
  session: import("./sessions.js").Session;
  depth: number;
  childCount: number;
  active: boolean;
  // Whether THIS row's inline rename input is open. Owned by the STORE (editingId),
  // NOT local useState — see openRename below. Passed down from <Sidebar> so the row
  // re-derives "am I being renamed?" from the store on every render, surviving any
  // remount/reconcile the 10s merge poll triggers (the CI rename flake: local editing
  // state was dropped when a background merge re-rendered/remounted the row mid-edit).
  editing: boolean;
  labelMode: LabelMode;
}) {
  const [draft, setDraft] = useState(s.title);

  // Open the rename. flushSync forces React to COMMIT the editing state before the
  // click handler returns, so the input mounts SYNCHRONOUSLY within the event rather
  // than on a later, interruptible render. This is HARDENING, not a bug fix: the
  // state machine is already correct (proven deterministically in jsdom — the input
  // opens + survives a same-tick merge storm with or without flushSync). But on a
  // severely CPU-starved main thread (GitHub's 2-core runner, mid agent-turn render
  // storm) a deferred commit can be delayed long enough that a test's next action —
  // or a real user's follow-up click — races the not-yet-mounted input. Committing
  // in-handler shrinks that window to zero. Seeding draft from the current title
  // (the store lock freezes this row in mergeFromServer, so the title can't shift).
  const openRename = () => {
    flushSync(() => {
      setDraft(s.title);
      sessionStore.setEditing(s.id);
    });
  };

  const commitRename = () => {
    const next = draft.trim();
    sessionStore.clearEditing(s.id); // close the input (store-owned)
    if (!next || next === s.title) return;
    sessionStore.renameSession(s.id, next); // optimistic + lock
    void renameConversation(agentHostConfig, s.id, next);
  };

  const toggleStar = () => {
    const next = !s.starred;
    sessionStore.setStarred(s.id, next); // optimistic
    void setConversationStarred(agentHostConfig, s.id, next);
  };

  const remove = () => {
    // Universal confirm on delete; a STARRED conversation gets a stronger warning.
    const msg = s.starred
      ? `"${s.title}" is starred. Deleting destroys its sandbox and data permanently. Delete anyway?`
      : `Delete "${s.title}"? This destroys its sandbox and data permanently.`;
    if (!window.confirm(msg)) return;
    sessionStore.deleteSession(s.id); // optimistic local removal
    void deleteConversation(agentHostConfig, s.id);
  };

  return (
    <div
      data-testid="session-item"
      // The SERVER's id, absent until the conversation is created. e2e cross-checks the
      // sidebar against the server by this; the row's React key is `s.id`, which for a
      // not-yet-created conversation is a local placeholder the server has never heard of.
      data-conversation-id={s.serverId}
      // A conversation the server has not created yet (an unsent "New chat"). e2e uses this
      // to tell an expected local-only row from a genuine UI/server divergence.
      data-pending-create={s.serverId === undefined ? "true" : undefined}
      data-active={active}
      data-starred={s.starred ? "true" : undefined}
      data-subagent={depth > 0 ? "true" : undefined}
      className={
        "group mb-1 flex items-center gap-1 rounded-md pe-1 text-sm " +
        (depth > 0 ? "ms-3 border-s ps-1 " : "") +
        (active ? "bg-accent" : "hover:bg-accent/50")
      }
    >
      {/* Star toggle — top-level only (subagents aren't independently retained). */}
      {depth === 0 && (
        <Button
          variant="ghost"
          size="icon-xs"
          data-testid="session-star"
          aria-label={s.starred ? `Unstar ${s.title}` : `Star ${s.title}`}
          aria-pressed={s.starred ? true : false}
          onClick={toggleStar}
          className={cn(
            "shrink-0",
            s.starred
              ? "text-warning"
              : "text-muted-foreground opacity-0 hover:text-warning group-hover:opacity-100"
          )}
        >
          {s.starred ? "★" : "☆"}
        </Button>
      )}

      {editing ? (
        <input
          data-testid="session-rename-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Commit on a genuine click-away, but NOT on a spurious re-render blur.
          // Under merge-poll contention the sidebar reconciles mid-rename and the
          // input transiently BLURS — focus lands on a SIBLING button IN THIS SAME ROW
          // (the Star/Rename/Delete buttons re-render) — even though the user hasn't
          // left. A synchronous onBlur commit there would commit + unmount the input
          // under the user's cursor (the CI flake: fill succeeds, then Enter hits a
          // detached node). So commit ONLY when focus moved to an element OUTSIDE this
          // row (a real navigation away — the thread, another row, the composer). A
          // blur with no relatedTarget, or one landing back inside this row, is a
          // reconciliation artifact and is ignored. Enter/Escape remain the explicit
          // commit/cancel paths, so nothing is lost.
          onBlur={(e) => {
            const movedOutOfRow =
              e.relatedTarget instanceof Node &&
              !e.currentTarget.closest('[data-testid="session-item"]')?.contains(e.relatedTarget);
            if (movedOutOfRow) commitRename();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") {
              setDraft(s.title);
              sessionStore.clearEditing(s.id);
            }
          }}
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-sm"
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => sessionStore.switchTo(s.id)}
          onDoubleClick={openRename}
          className={cn("min-w-0 flex-1 justify-start truncate", active && "font-medium")}
          title={`${s.title} — double-click to rename`}
        >
          {depth > 0 && <span className="me-1 text-muted-foreground" aria-hidden>↳</span>}
          <span data-testid="session-title">{sessionLabel(s, labelMode)}</span>
          {childCount > 0 && (
            <span data-testid="subagent-count" className="ms-1.5 text-xs text-muted-foreground">
              ▸ {childCount} subagent{childCount === 1 ? "" : "s"}
            </span>
          )}
        </Button>
      )}

      {/* Provider badges for any linked external resources (GitHub/Slack/…). */}
      {!editing && s.sources && s.sources.length > 0 && (
        <span className="flex shrink-0 items-center gap-0.5">
          {s.sources.map((src) => (
            <SourceBadge key={src} source={src} />
          ))}
        </span>
      )}

      {/* Explicit rename affordance — a dedicated button (not overloading the title's
          click/double-click, which raced with switchTo re-rendering the row). */}
      {!editing && (
        <Button
          variant="ghost"
          size="icon-xs"
          data-testid="session-rename"
          aria-label={`Rename ${s.title}`}
          title="Rename"
          onClick={(e) => {
            e.stopPropagation();
            openRename();
          }}
          className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
        >
          ✎
        </Button>
      )}

      {!editing && (
        <Button
          variant="ghost"
          size="icon-xs"
          data-testid="session-delete"
          aria-label={`Delete ${s.title}`}
          onClick={remove}
          className="shrink-0 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        >
          ✕
        </Button>
      )}
    </div>
  );
});

// memo()'d: <Sidebar> is a direct child of <RuntimeProvider>, which re-renders on
// EVERY AG-UI event during an agent turn (streaming reasoning, tool calls, run
// status, the sandbox "Starting…" poll). It takes no props and reads only its own
// sessionStore (useSessions), so memo makes it re-render ONLY on store changes — not
// on every parent tick. That parent-render storm was the surviving rename-flake
// disruptor: while the agent streamed, the constant <Sidebar> re-renders raced the
// rename-open click's store update, so the input intermittently never mounted (CI
// mode "input never appears"). With the merge frozen during edit (mergeFromServer)
// AND the parent storm gone, the ONLY thing that re-renders the sidebar mid-rename is
// the user's own setEditing/clearEditing — nothing can drop or detach the input.
export const Sidebar = memo(function Sidebar() {
  const state = useSessions();
  const { currentId, editingId, scope, query, providerFilter, labelMode } = state;
  // Hierarchy: each parent followed by its subagents (depth 1). filteredSessions
  // applies Mine/provider/query; nestSubagents groups children under parents and
  // AUTO-COLLAPSES a parent's subagents unless it (or a child) is the active
  // conversation — so an inactive conversation's subagents don't clutter the list.
  const rows = nestSubagents(filteredSessions(state), currentId);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // How many advanced filters are "active" (non-default) — a badge on the toggle so
  // the user knows a filter is narrowing the list even when the panel is collapsed.
  const activeFilters =
    (scope === "all" ? 1 : 0) + providerFilter.length + (labelMode !== "title" ? 1 : 0);

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-muted/30">
      <div className="p-3">
        <Button
          variant="outline"
          size="sm"
          data-testid="new-session"
          onClick={() => sessionStore.newSession()}
          className="w-full"
        >
          + New conversation
        </Button>
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
        <Button
          variant="ghost"
          size="xs"
          data-testid="filters-toggle"
          data-open={filtersOpen}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((o) => !o)}
          className="w-full justify-start gap-1.5 px-1 text-muted-foreground"
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
        </Button>

        {filtersOpen && (
          <div data-testid="filters-panel" className="mt-1 flex flex-col gap-2 rounded-md border bg-background/60 p-2 text-xs">
            {/* Default — Mine / All (conversations are public; this is just a view;
                Mine is the default). */}
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-muted-foreground">Default</span>
              <div data-testid="scope-toggle" className="flex flex-1 gap-1">
                {(["mine", "all"] as const).map((s) => (
                  <Button
                    key={s}
                    variant="ghost"
                    size="xs"
                    data-testid={`scope-${s}`}
                    data-active={scope === s}
                    onClick={() => sessionStore.setScope(s)}
                    className={cn(
                      "flex-1 capitalize",
                      scope === s ? "bg-accent font-medium" : "text-muted-foreground"
                    )}
                  >
                    {s}
                  </Button>
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
                    <Button
                      key={p}
                      variant="outline"
                      size="icon-xs"
                      data-testid={`provider-${p}`}
                      data-active={active}
                      aria-pressed={active}
                      aria-label={`Filter by ${sourceLabel(p)}`}
                      title={`Filter by ${sourceLabel(p)}`}
                      onClick={() => sessionStore.toggleProvider(p)}
                      className={cn(
                        active
                          ? "border-foreground bg-accent"
                          : "border-transparent opacity-40 hover:opacity-100"
                      )}
                    >
                      <SourceBadge source={p} size={15} />
                    </Button>
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
                    <Button
                      key={m}
                      variant="ghost"
                      size="icon-xs"
                      role="radio"
                      aria-checked={active}
                      data-testid={`label-${m}`}
                      data-active={active}
                      aria-label={lbl}
                      title={lbl}
                      onClick={() => sessionStore.setLabelMode(m as LabelMode)}
                      className={cn(
                        "flex-1",
                        active ? "bg-accent text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {m === "title" ? <TitleBadge size={15} /> : <SourceBadge source={m} size={15} />}
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <nav data-testid="session-list" className="flex-1 overflow-y-auto px-2 pb-2">
        {rows.length === 0 && (
          <p data-testid="session-empty" className="px-3 py-2 text-sm text-muted-foreground">
            No chats match.
          </p>
        )}
        {rows.map(({ session: s, depth, childCount }) => (
          <SessionRow
            key={s.id}
            session={s}
            depth={depth}
            childCount={childCount}
            active={s.id === currentId}
            editing={s.id === editingId}
            labelMode={labelMode}
          />
        ))}
      </nav>
      {/* The current conversation's external resources (GitHub PR / Slack thread
          / …), collapsible. Hidden when there are none. */}
      <LinkedResources />
    </aside>
  );
});
