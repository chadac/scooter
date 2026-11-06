/**
 * Session selector — the left sidebar. Lists conversations with titles, the
 * current one highlighted, plus a "new conversation" button.
 *
 * testids match the e2e specs: session-list, session-item, session-title,
 * new-session.
 */

import { memo, useEffect, useState, type ReactNode } from "react";
import { Bot, ChevronRight, CornerDownRight, FolderPlus, Lock, MoreHorizontal, Plus, Star } from "lucide-react";
import { DropdownMenu, Popover } from "radix-ui";

import { FolderGlyph, IconPicker } from "./FolderGlyph.js";
import { buildFolders, currentBranch, folderStore, moveTo, useFolders, type FolderSection } from "./folders.js";
import {
  sessionStore,
  useSessions,
  filteredSessions,
  nestSubagents,
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
      draggable={depth === 0}
      onDragStart={(e) => e.dataTransfer.setData(CONV_MIME, s.id)}
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

const CONV_MIME = "application/x-scooter-conversation";
const FOLDER_MIME = "application/x-scooter-folder";
// The folder being dragged; dragover can't read the payload.
let draggingFolder: string | null = null;

// Worst first: a collapsed folder shows its most urgent dot.
const DOT_RANK: TurnDot[] = ["question", "failed", "active", "unread", "unread-idle"];

/** Files a dropped conversation into `folderId` (null: Recent). */
function DropZone({
  folderId,
  className,
  children,
}: {
  folderId: string | null;
  className?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      data-testid={folderId ? "folder-section" : "recent-section"}
      data-folder-id={folderId ?? undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(CONV_MIME)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(CONV_MIME);
        const s = sessionStore.get().sessions.find((x) => x.id === id);
        if (s) void moveTo(s, folderId);
      }}
      className={cn(className, over && "bg-accent/50 ring-1 ring-ring")}
    >
      {children}
    </div>
  );
}

function FolderSectionView({
  section: f,
  open,
  first,
  last,
  currentId,
  labelMode,
}: {
  section: FolderSection;
  /** First or last of the user's folders, for Move up/down. */
  first?: boolean;
  last?: boolean;
  /** Collapsed still shows the branch to the open conversation. */
  open: boolean;
  currentId: string;
  labelMode: LabelMode;
}) {
  const builtin = f.builtin;
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [dropSide, setDropSide] = useState<"before" | "after" | null>(null);
  // A cancelled drag never fires dragleave here, so clear on dragend.
  useEffect(() => {
    if (!dropSide) return;
    const clear = () => setDropSide(null);
    document.addEventListener("dragend", clear);
    return () => document.removeEventListener("dragend", clear);
  }, [dropSide]);
  const shown = open ? f.rows : currentBranch(f.rows, currentId);
  const top = f.rows.filter((r) => r.depth === 0);
  const dots = f.rows.map((r) => turnDot(r.session)).filter((d): d is TurnDot => !!d);
  const rollup = DOT_RANK.find((d) => dots.includes(d));
  return (
    <div
      className="relative"
      onDragOver={(e) => {
        if (!draggingFolder || draggingFolder === f.id) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDropSide(builtin || e.clientY > r.top + r.height / 2 ? "after" : "before");
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropSide(null);
      }}
      onDrop={(e) => {
        if (!dropSide || !draggingFolder) return;
        e.preventDefault();
        void folderStore.reorder(draggingFolder, f.id, dropSide === "after");
        setDropSide(null);
      }}
    >
      {dropSide && (
        <div
          aria-hidden
          data-testid="folder-drop-line"
          className={cn(
            "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded bg-primary",
            dropSide === "before" ? "-top-[3px]" : "-bottom-[3px]",
          )}
        />
      )}
      <DropZone folderId={f.id} className="mb-1 rounded-md">
        <div
          data-testid="folder-header"
          data-folder-id={f.id}
          draggable={!builtin && !renaming}
          onDragStart={(e) => {
            e.dataTransfer.setData(FOLDER_MIME, f.id);
            e.dataTransfer.effectAllowed = "move";
            draggingFolder = f.id;
          }}
          onDragEnd={() => (draggingFolder = null)}
          className="group/folder flex h-7 items-center gap-1 rounded-md px-1 text-[13px] text-muted-foreground hover:bg-accent/60"
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={() => folderStore.toggleCollapsed(f.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
          >
            <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
            <Popover.Root open={picking} onOpenChange={setPicking}>
              <Popover.Anchor asChild>
                <span className="flex">
                  <FolderGlyph builtin={builtin} icon={f.icon} />
                </span>
              </Popover.Anchor>
              <Popover.Portal>
                <Popover.Content
                  align="start"
                  sideOffset={6}
                  onClick={(e) => e.stopPropagation()}
                  className="z-50 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
                >
                  <IconPicker
                    current={f.icon}
                    onPick={(icon) => {
                      void folderStore.setIcon(f.id, icon);
                      setPicking(false);
                    }}
                  />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            {renaming ? (
              <input
                autoFocus
                defaultValue={f.name}
                aria-label="Folder name"
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  void folderStore.rename(f.id, e.currentTarget.value);
                  setRenaming(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(false);
                }}
                className="h-5 min-w-0 flex-1 rounded border border-input bg-background px-1 text-foreground"
              />
            ) : (
              <span className={cn("truncate font-medium", builtin ? "text-foreground" : "text-foreground/90")}>{f.name}</span>
            )}
          </button>
          {!open && rollup && <StatusDot dot={rollup} />}
          {/* Count and actions share a slot, so dots line up. */}
          <span className="relative flex w-5 shrink-0 justify-end">
            <span
              data-testid="folder-count"
              className={cn(
                "text-[11px] tabular-nums",
                // Hidden exactly when the actions button shows in its place.
                !builtin && "group-hover/folder:invisible group-has-[[data-folder-actions]:focus-visible]/folder:invisible",
                menuOpen && "invisible",
              )}
            >
              {top.length || ""}
            </span>
          {!builtin && (
            <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  data-folder-actions
                  aria-label={`${f.name} folder actions`}
                  className="absolute inset-y-0 end-0 my-auto flex size-5 items-center justify-center rounded opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover/folder:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className="z-50 min-w-32 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
                >
                  <DropdownMenu.Item
                    onSelect={() => setTimeout(() => setRenaming(true))}
                    className="cursor-pointer rounded px-2 py-1 outline-none data-[highlighted]:bg-accent"
                  >
                    Rename
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => setTimeout(() => setPicking(true))}
                    className="cursor-pointer rounded px-2 py-1 outline-none data-[highlighted]:bg-accent"
                  >
                    {f.icon ? "Change icon" : "Set icon"}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={first}
                    onSelect={() => void folderStore.nudge(f.id, -1)}
                    className="cursor-pointer rounded px-2 py-1 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
                  >
                    Move up
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={last}
                    onSelect={() => void folderStore.nudge(f.id, 1)}
                    className="cursor-pointer rounded px-2 py-1 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
                  >
                    Move down
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => {
                      if (top.length === 0 || window.confirm(`Delete "${f.name}"? Its ${top.length} conversation(s) move to Recent.`))
                        void folderStore.remove(f.id);
                    }}
                    className="cursor-pointer rounded px-2 py-1 text-destructive outline-none data-[highlighted]:bg-destructive/10"
                  >
                    Delete folder
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
          </span>
        </div>
        {shown.length > 0 || open ? (
          <div className="ps-3">
            {open && f.rows.length === 0 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {builtin ? "Star a conversation to pin it here." : "Drag conversations here."}
              </p>
            )}
            {shown.map(({ session: s, depth, childCount }) => (
              <SessionRow
                key={s.id}
                session={s}
                depth={depth}
                childCount={childCount}
                active={s.id === currentId}
                labelMode={labelMode}
              />
            ))}
            {open && (
              <button
                type="button"
                data-testid="folder-new-session"
                onClick={() => folderStore.newIn(f.id)}
                className="flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground/80 hover:bg-accent/60 hover:text-foreground"
              >
                <Plus className="size-3.5" aria-hidden /> New conversation
              </button>
            )}
          </div>
        ) : null}
      </DropZone>
    </div>
  );
}

/** "New folder" button that turns into an inline name field. */
function NewFolder() {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button
        type="button"
        data-testid="new-folder"
        onClick={() => setEditing(true)}
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-1 ps-2.5 text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      >
        <FolderPlus className="size-3.5" aria-hidden /> New folder
      </button>
    );
  }
  return (
    <input
      autoFocus
      placeholder="Folder name"
      aria-label="New folder name"
      onBlur={(e) => {
        void folderStore.create(e.currentTarget.value);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setEditing(false);
      }}
      className="ms-1.5 h-7 w-[calc(100%-0.375rem)] rounded-md border border-input bg-background px-2 text-[13px]"
    />
  );
}

// memo()'d: <RuntimeProvider> re-renders on every AG-UI event during an agent turn,
// and the sidebar reads only sessionStore, so this limits it to store changes.
export const Sidebar = memo(function Sidebar() {
  const state = useSessions();
  const { currentId, scope, query, providerFilter, labelMode } = state;
  // filteredSessions applies Mine/provider/query; nestSubagents groups children under
  // parents and collapses them unless the branch holds the active conversation.
  const rows = nestSubagents(filteredSessions(state), currentId);
  // Each conversation lands in exactly one section.
  const fstate = useFolders();
  const { folders: folderSections, recent: recentRows } = buildFolders(rows, fstate);
  const userIds = fstate.folders.filter((f) => f.kind === "user").map((f) => f.id);
  const searching = query.trim() !== "" || providerFilter.length > 0;
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
          onClick={() => folderStore.newIn(null)}
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
        {folderSections
          .filter((f) => !searching || f.rows.length > 0)
          .map((f) => (
            <FolderSectionView
              key={f.id}
              section={f}
              first={f.id === userIds[0]}
              last={f.id === userIds.at(-1)}
              open={searching || !fstate.collapsed[f.id]}
              currentId={currentId}
              labelMode={labelMode}
            />
          ))}
        {!searching && <NewFolder />}
        <DropZone folderId={null} className="mt-2 rounded-md">
          <SectionHeader label="Recent" />
          {recentRows.length === 0 && rows.length > 0 && !searching && (
            <p className="px-2 pb-2 text-xs text-muted-foreground">Everything is filed.</p>
          )}
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
        </DropZone>
      </nav>
      {/* The current conversation's external resources, collapsible and hidden when
          there are none. */}
      <LinkedResources />
    </aside>
  );
});
