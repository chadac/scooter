/**
 * Session selector — the left sidebar. Lists conversations with titles, the
 * current one highlighted, plus a "new conversation" button.
 *
 * testids match the e2e specs: session-list, session-item, session-title,
 * new-session.
 */

import { memo, useEffect, useState, type ReactNode } from "react";
import { Bot, ChevronRight, CornerDownRight, Lock, Plus, StarFilled } from "@/icons";

import {
  sessionStore,
  useSessions,
  filteredSessions,
  nestSubagents,
  splitSections,
  sessionLabel,
  linkProviders,
  turnDot,
  type LabelMode,
  type TurnDot,
} from "./sessions.js";
import { LinkedResources } from "./LinkedResources.js";
import { mobileNav, useDrawer } from "./mobileNav.js";
import { SourceBadge, sourceLabel, TitleBadge } from "./sourceIcon.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const DOT: Record<TurnDot, { cls: string; label: string; hint: string }> = {
  question: { cls: "text-status-question", label: "Waiting on you", hint: "The agent asked a question or needs an approval." },
  active: { cls: "bg-success", label: "Agent working", hint: "A turn is in progress." },
  unread: { cls: "bg-status-active", label: "Unread reply", hint: "The agent replied since you last looked." },
  "unread-idle": { cls: "bg-warning", label: "Unread reply, sandbox suspended", hint: "The agent replied, then its sandbox was suspended." },
  idle: { cls: "bg-muted-foreground", label: "Sandbox running", hint: "Nothing unread; the agent is idle but its sandbox is still up." },
  failed: { cls: "bg-destructive", label: "Sandbox failed", hint: "The sandbox could not run." },
};

function StatusDot({ dot }: { dot: TurnDot }) {
  const { cls, label, hint } = DOT[dot];
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="session-status-dot"
            data-dot={dot}
            role="img"
            aria-label={label}
            className="-m-1.5 flex shrink-0 items-center justify-center p-1.5"
          >
            {dot === "question" ? (
              <span
                aria-hidden
                className={cn("flex h-3 w-3 items-center justify-center rounded-full bg-red-500/25 text-[10px] font-bold leading-none", cls)}
              >
                !
              </span>
            ) : (
              <span className={cn("h-1 w-1 rounded-full", cls)} />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          <div className="font-medium">{label}</div>
          <div className="opacity-80">{hint}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** A section heading in the conversation list (Starred / Recent). */
function SectionHeader({ icon, label }: { icon?: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1 px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground first:pt-1">
      {icon}
      {label}
    </div>
  );
}

/** A small "?" affordance with a native-title tooltip. */
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

/** One conversation row: select only. Star / rename / delete live beside the title in the
 *  header (HeaderConversationTitle), away from the tap target that switches conversations.
 *  memo()'d so a stream merge, which reuses an unchanged Session object, does not re-render it. */
const SessionRow = memo(function SessionRow({
  session: s,
  depth,
  childCount,
  active,
  labelMode,
}: {
  session: import("./sessions.js").Session;
  depth: number;
  childCount: number;
  active: boolean;
  labelMode: LabelMode;
}) {
  const dot = turnDot(s);

  return (
    <div
      data-testid="session-item"
      // The server's id, absent until the conversation is created; e2e cross-checks the
      // sidebar against the server by it.
      data-conversation-id={s.serverId}
      // Marks a conversation the server has not created yet, so e2e can tell a local-only
      // row from a divergence.
      data-pending-create={s.serverId === undefined ? "true" : undefined}
      data-active={active}
      data-starred={s.starred ? "true" : undefined}
      data-private={s.visibility === "private" ? "true" : undefined}
      data-subagent={depth > 0 ? "true" : undefined}
      className={
        "group relative mb-0.5 flex items-center gap-1 rounded-lg ps-1.5 pe-1 text-sm " +
        (depth > 0 ? "ms-3 border-s border-border ps-1.5 " : "") +
        (active ? "bg-accent font-medium" : "hover:bg-accent/60")
      }
    >
      {/* Leading status dot in a fixed-width slot so titles align whether or not a row has one. */}
      <span className="flex w-1 shrink-0 items-center justify-center">
        {dot && <StatusDot dot={dot} />}
      </span>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => sessionStore.switchTo(s.id)}
        className={cn("min-w-0 flex-1 justify-start truncate", active && "font-medium")}
        title={s.title}
      >
        {depth > 0 && <CornerDownRight className="me-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span data-testid="session-title">{sessionLabel(s, labelMode)}</span>
        {s.visibility === "private" && (
          <span
            data-testid="session-private"
            className="ms-1.5 text-xs text-muted-foreground"
            title="Private: only you can see it"
            aria-label="Private"
          >
            <Lock className="size-3" aria-hidden />
          </span>
        )}
        {childCount > 0 && (
          <span data-testid="subagent-count" className="ms-1.5 text-xs text-muted-foreground">
            <Bot className="me-0.5 inline size-3" aria-hidden />{childCount} subagent{childCount === 1 ? "" : "s"}
          </span>
        )}
      </Button>

      {/* Provider link plates for linked external resources. */}
      {s.sources && s.sources.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {s.sources.map((src) => (
            <span
              key={src}
              className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border bg-card"
            >
              <SourceBadge source={src} />
            </span>
          ))}
        </span>
      )}
    </div>
  );
});

// memo()'d: <RuntimeProvider> re-renders on every AG-UI event during an agent turn,
// and the sidebar reads only sessionStore, so this limits it to store changes.
export const Sidebar = memo(function Sidebar() {
  const state = useSessions();
  const { currentId, scope, query, providerFilter, labelMode } = state;
  // filteredSessions applies Mine/provider/query; nestSubagents groups children under
  // parents and collapses them unless the branch holds the active conversation.
  const rows = nestSubagents(filteredSessions(state), currentId);
  // Routing is per conversation, so a starred conversation never also appears in Recent.
  const { starred: starredRows, recent: recentRows } = splitSections(rows);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // On mobile the sidebar is an overlay drawer; close it when the conversation changes
  // to reveal the thread.
  const drawer = useDrawer();
  useEffect(() => {
    mobileNav.close();
  }, [currentId]);

  // Count of non-default filters, shown as a badge on the toggle while the panel is collapsed.
  const activeFilters =
    (scope === "all" ? 1 : 0) + providerFilter.length + (labelMode !== "title" ? 1 : 0);

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        "flex flex-col border-r border-sidebar-border bg-sidebar",
        // Mobile: off-canvas left drawer over the thread, below the h-11 header.
        "fixed bottom-0 left-0 top-11 z-40 w-[86vw] max-w-72 -translate-x-full shadow-xl transition-transform duration-200 ease-out",
        // Desktop (desk, ≥1200px): a static in-flow column.
        "desk:static desk:h-full desk:w-64 desk:max-w-none desk:translate-x-0 desk:shadow-none desk:transition-none",
        drawer === "sessions" && "translate-x-0",
      )}
    >
      <div className="p-3">
        <Button
          variant="default"
          size="sm"
          data-testid="new-session"
          onClick={() => sessionStore.startFresh()}
          className="w-full justify-center gap-1.5"
        >
          <Plus className="size-4" aria-hidden /> New conversation
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
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground"
        />
      </div>

      {/* Advanced filters: Scope (Mine/All), the linked-provider chips, and the Show
          (label-mode) control. */}
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
          <ChevronRight aria-hidden className={"size-3.5 transition-transform " + (filtersOpen ? "rotate-90" : "")} />
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
            {/* Default: Mine / All, a view filter over public conversations. */}
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

            {/* Only: multi-select provider chips; any selected shows only chats linked to
                one of them. */}
            <div className="flex items-center gap-2">
              <span className="flex w-12 shrink-0 items-center gap-1 text-muted-foreground">
                Only
                <InfoTip text="Only show conversations linked to the selected provider(s)." />
              </span>
              <div data-testid="provider-filter" className="flex flex-1 flex-wrap gap-1.5">
                {linkProviders().map((p) => {
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

            {/* Show: what each row displays, the conversation title or a provider's
                linked-resource name. */}
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
                {["title", ...linkProviders()].map((m) => {
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
        {starredRows.length > 0 && (
          <SectionHeader
            label="Starred"
            icon={<StarFilled className="size-3 text-warning" />}
          />
        )}
        {starredRows.map(({ session: s, depth, childCount }) => (
          <SessionRow
            key={s.id}
            session={s}
            depth={depth}
            childCount={childCount}
            active={s.id === currentId}
            labelMode={labelMode}
          />
        ))}
        {recentRows.length > 0 && <SectionHeader label="Recent" />}
        {recentRows.map(({ session: s, depth, childCount }) => (
          <SessionRow
            key={s.id}
            session={s}
            depth={depth}
            childCount={childCount}
            active={s.id === currentId}
            labelMode={labelMode}
          />
        ))}
      </nav>
      {/* The current conversation's external resources, collapsible and hidden when
          there are none. */}
      <LinkedResources />
    </aside>
  );
});
