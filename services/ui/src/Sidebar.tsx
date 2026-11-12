/**
 * Session selector — the left sidebar. Lists conversations with titles, the
 * current one highlighted, plus a "new conversation" button.
 *
 * testids match the e2e specs: session-list, session-item, session-title,
 * new-session.
 */

import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import { Bot, Check, ChevronRight, CornerDownRight, FolderPlus, Hourglass, InfinityIcon, Lock, MoreHorizontal, Plus, Star } from "lucide-react";
import { DropdownMenu, Popover } from "radix-ui";

import { FolderGlyph, IconPicker } from "./FolderGlyph.js";
import { CustomLifetimeForm } from "./RetentionForm.js";
import { lifetimeChoices, lifetimeLabel, timeLeft } from "./retention.js";
import {
  allRows,
  buildFolders,
  canMoveInto,
  currentBranch,
  effectiveLifetime,
  expiryOf,
  folderPath,
  folderStore,
  MAX_FOLDER_DEPTH,
  moveTo,
  useFolders,
  type DropPlace,
  type FolderSection,
} from "./folders.js";
import {
  sessionStore,
  useSessions,
  filteredSessions,
  nestSubagents,
  sessionLabel,
  linkForProvider,
  linkProviders,
  turnDot,
  type LabelMode,
  type TurnDot,
} from "./sessions.js";
import { LinkText } from "./LinkText.js";
import { LinkedResources } from "./LinkedResources.js";
import { mobileNav, useDrawer } from "./mobileNav.js";
import { SourceBadge, sourceLabel, TitleBadge } from "./sourceIcon.js";
import { reloadInto } from "./appUpdate.js";
import { ChildIcon } from "./ChildIcon.js";
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

export function StatusDot({ dot }: { dot: TurnDot }) {
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

/** A row's label: the provider's link, drawn by its contrib's view, else the title. */
function SessionLabel({ session: s, mode }: { session: import("./sessions.js").Session; mode: LabelMode }) {
  const link = mode !== "title" ? linkForProvider(s, mode) : undefined;
  return link ? <LinkText link={link} /> : <span className="truncate">{sessionLabel(s, mode)}</span>;
}

// One shared minute tick for every row's expiry hint.
const minuteListeners = new Set<() => void>();
let minute = Date.now();
let minuteTimer: ReturnType<typeof setInterval> | undefined;
function subscribeMinute(l: () => void) {
  minuteListeners.add(l);
  minuteTimer ??= setInterval(() => {
    minute = Date.now();
    for (const x of minuteListeners) x();
  }, 60_000);
  return () => {
    minuteListeners.delete(l);
    if (minuteListeners.size > 0) return;
    clearInterval(minuteTimer);
    minuteTimer = undefined;
  };
}
const readMinute = () => minute;

/** An hourglass and the time left, for a row near its retention lifetime. */
function ExpiryHint({ session }: { session: import("./sessions.js").Session }) {
  useFolders();
  const now = useSyncExternalStore(subscribeMinute, readMinute);
  const expiry = expiryOf(session);
  const left = expiry && timeLeft(expiry, now);
  if (!expiry || !left) return null;
  const why = `Deleted in ${left}: it has been idle for most of its ${lifetimeLabel(expiry.hours)} retention. Use, star or move it to keep it.`;
  return (
    <span
      data-testid="session-expiry"
      title={why}
      aria-label={why}
      className="flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground"
    >
      <Hourglass className="size-3" aria-hidden />
      {left}
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
      data-session-kind={s.kind}
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
        onClick={() => reloadInto(s.serverId) || sessionStore.switchTo(s.id)}
        // The row owns the hover highlight; never stack a second.
        className={cn(
          "min-w-0 flex-1 justify-start truncate hover:bg-transparent dark:hover:bg-transparent",
          active && "font-medium",
        )}
        title={s.title}
      >
        {depth > 0 && <CornerDownRight className="me-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span data-testid="session-title" className="flex min-w-0 items-center">
          <SessionLabel session={s} mode={labelMode} />
        </span>
        {s.kind === "session" && <ChildIcon session={s} className="ms-1.5" />}
        {s.visibility === "private" && (
          <span
            data-testid="session-private"
            className="ms-1.5 shrink-0 text-xs text-muted-foreground"
            title="Private: only you can see it"
            aria-label="Private"
          >
            <Lock className="size-3" aria-hidden />
          </span>
        )}
        {childCount > 0 && (
          <span
            data-testid="subagent-count"
            className="ms-1.5 shrink-0 text-xs text-muted-foreground"
            title={`${childCount} subagent${childCount === 1 ? "" : "s"}`}
            aria-label={`${childCount} subagent${childCount === 1 ? "" : "s"}`}
          >
            <Bot className="me-0.5 inline size-3" aria-hidden />{childCount}
          </span>
        )}
      </Button>

      {depth === 0 && <ExpiryHint session={s} />}

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
        // The innermost folder takes it, not every ancestor.
        e.stopPropagation();
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(CONV_MIME);
        if (!id) return;
        e.stopPropagation();
        const s = sessionStore.get().sessions.find((x) => x.id === id);
        if (s) void moveTo(s, folderId);
      }}
      className={cn(className, over && "bg-accent/50 ring-1 ring-ring")}
    >
      {children}
    </div>
  );
}

const menuItem =
  "cursor-pointer rounded px-2 py-1 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[state=open]:bg-accent";
const menuContent = "z-50 min-w-36 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md";

/** Does this section, or a subfolder, hold `currentId`? */
const holds = (f: FolderSection, currentId: string): boolean =>
  f.rows.some((r) => r.session.id === currentId) || f.children.some((c) => holds(c, currentId));

function FolderSectionView({
  section: f,
  parent,
  first,
  last,
  closed,
  searching,
  currentId,
  labelMode,
}: {
  section: FolderSection;
  parent?: FolderSection;
  /** First or last among its siblings, for Move up/down. */
  first?: boolean;
  last?: boolean;
  /** An ancestor is collapsed: show only the open conversation's branch. */
  closed?: boolean;
  searching: boolean;
  currentId: string;
  labelMode: LabelMode;
}) {
  const fstate = useFolders();
  const [renaming, setRenaming] = useState(false);
  const [addingSub, setAddingSub] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [drop, setDrop] = useState<{ place: DropPlace; ok: boolean } | null>(null);
  // A cancelled drag never fires dragleave here, so clear on dragend.
  useEffect(() => {
    if (!drop) return;
    const clear = () => setDrop(null);
    document.addEventListener("dragend", clear);
    return () => document.removeEventListener("dragend", clear);
  }, [drop]);
  const open = !closed && (searching || !fstate.collapsed[f.id]);
  const shown = open ? f.rows : currentBranch(f.rows, currentId);
  const kids = f.children.filter((c) => (searching ? allRows(c).length > 0 : open || holds(c, currentId)));
  const everything = allRows(f);
  const count = (open ? f.rows : everything).filter((r) => r.depth === 0).length;
  const dots = (open ? f.rows : everything).map((r) => turnDot(r.session)).filter((d): d is TurnDot => !!d);
  const rollup = DOT_RANK.find((d) => dots.includes(d));
  const nestable = !f.locked && f.depth < MAX_FOLDER_DEPTH;
  const inherited = parent && effectiveLifetime(parent.id);
  const lifetime = f.conversationLifetimeHours ?? undefined;
  const fallback = inherited
    ? `Same as ${parent!.name} (${lifetimeLabel(inherited.hours)})`
    : fstate.defaultLifetimeHours !== undefined
      ? `Default (${lifetimeLabel(fstate.defaultLifetimeHours)})`
      : "Default";
  const moveTargets = fstate.folders.filter(
    (x) => x.kind === "user" && x.id !== parent?.id && canMoveInto(f.id, x.id),
  );
  const dropAt = (e: DragEvent<HTMLElement>): { place: DropPlace; ok: boolean } | null => {
    const from = draggingFolder;
    if (!from || from === f.id) return null;
    if (f.starred) return { place: "after", ok: true };
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const into = canMoveInto(from, f.id);
    const place: DropPlace = into ? (y < 0.25 ? "before" : y > 0.75 ? "after" : "into") : y < 0.5 ? "before" : "after";
    return { place, ok: into || canMoveInto(from, parent?.id ?? null) };
  };
  return (
    <div className="relative" data-testid="folder" data-folder-id={f.id} data-depth={f.depth}>
      {drop && drop.place !== "into" && (
        <div
          aria-hidden
          data-testid="folder-drop-line"
          data-ok={drop.ok}
          className={cn(
            "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded",
            drop.ok ? "bg-primary" : "bg-muted-foreground/40",
            drop.place === "before" ? "-top-[3px]" : "-bottom-[3px]",
          )}
        />
      )}
      {drop && !drop.ok && (
        <span
          role="status"
          className="pointer-events-none absolute end-1 top-0 z-20 rounded bg-foreground px-1.5 py-0.5 text-[11px] text-background"
        >
          Too deep: max {MAX_FOLDER_DEPTH} levels
        </span>
      )}
      <DropZone folderId={f.id} className="mb-1 rounded-md">
        <div
          data-testid="folder-header"
          data-folder-id={f.id}
          draggable={!f.locked && !renaming}
          onDragStart={(e) => {
            e.dataTransfer.setData(FOLDER_MIME, f.id);
            e.dataTransfer.effectAllowed = "move";
            draggingFolder = f.id;
          }}
          onDragEnd={() => (draggingFolder = null)}
          onDragOver={(e) => {
            const at = dropAt(e);
            if (!at) return;
            if (at.ok) e.preventDefault();
            if (drop?.place !== at.place || drop.ok !== at.ok) setDrop(at);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
          }}
          onDrop={(e) => {
            // Read the event, not state: drops can outrun re-renders.
            const at = dropAt(e);
            if (!at?.ok || !draggingFolder) return;
            e.preventDefault();
            void folderStore.reorder(draggingFolder, f.id, at.place);
            setDrop(null);
          }}
          className={cn(
            "group/folder flex h-7 items-center gap-1 rounded-md px-1 text-[13px] text-muted-foreground hover:bg-accent/60",
            drop?.place === "into" && "bg-primary/10 ring-1 ring-primary",
          )}
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
                  <FolderGlyph starred={f.starred} icon={f.icon} />
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
              <span className={cn("truncate font-medium", f.locked ? "text-foreground" : "text-foreground/90")}>{f.name}</span>
            )}
            {!f.starred && f.conversationLifetimeHours !== undefined && (
              <span
                data-testid="folder-lifetime"
                title={
                  f.conversationLifetimeHours === 0
                    ? "Conversations here are kept forever"
                    : `Conversations here are deleted after ${lifetimeLabel(f.conversationLifetimeHours)} idle`
                }
                className="flex shrink-0 text-muted-foreground/70"
              >
                {f.conversationLifetimeHours === 0 ? <InfinityIcon className="size-3" aria-hidden /> : <Hourglass className="size-3" aria-hidden />}
              </span>
            )}
          </button>
          {!open && rollup && <StatusDot dot={rollup} />}
          <Popover.Root open={customizing} onOpenChange={setCustomizing}>
            <Popover.Anchor className="self-stretch" />
            <Popover.Portal>
              <Popover.Content
                align="end"
                sideOffset={6}
                className="z-50 rounded-md border bg-popover p-2.5 text-popover-foreground shadow-md"
              >
                <CustomLifetimeForm
                  initialHours={lifetime}
                  onSave={(hours) => {
                    void folderStore.setLifetime(f.id, hours);
                    setCustomizing(false);
                  }}
                  onCancel={() => setCustomizing(false)}
                />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          {/* Count and actions share a slot, so dots line up. */}
          <span className="relative flex w-5 shrink-0 justify-end">
            <span
              data-testid="folder-count"
              className={cn(
                "text-[11px] tabular-nums",
                // Hidden exactly when the actions button shows in its place.
                !f.locked && "group-hover/folder:invisible group-has-[[data-folder-actions]:focus-visible]/folder:invisible",
                menuOpen && "invisible",
              )}
            >
              {count || ""}
            </span>
            {!f.locked && (
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
                  <DropdownMenu.Content align="start" sideOffset={4} className={menuContent}>
                    <DropdownMenu.Item onSelect={() => setTimeout(() => setRenaming(true))} className={menuItem}>
                      Rename
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={() => setTimeout(() => setPicking(true))} className={menuItem}>
                      {f.icon ? "Change icon" : "Set icon"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      disabled={!nestable}
                      onSelect={() => {
                        if (!open) folderStore.toggleCollapsed(f.id);
                        setTimeout(() => setAddingSub(true));
                      }}
                      className={cn(menuItem, "flex justify-between gap-3")}
                    >
                      New subfolder
                      {!nestable && <span className="text-xs text-muted-foreground">max depth</span>}
                    </DropdownMenu.Item>
                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger className={cn(menuItem, "flex justify-between gap-3")}>
                        Conversation retention policy <ChevronRight className="size-3.5" aria-hidden />
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent sideOffset={4} className={menuContent}>
                          <DropdownMenu.RadioGroup
                            value={lifetime === undefined ? "inherit" : String(lifetime)}
                            onValueChange={(v) => void folderStore.setLifetime(f.id, v === "inherit" ? null : Number(v))}
                          >
                            <DropdownMenu.RadioItem value="inherit" className={cn(menuItem, "flex gap-2")}>
                              <span className="w-3.5">
                                <DropdownMenu.ItemIndicator>
                                  <Check className="size-3.5" />
                                </DropdownMenu.ItemIndicator>
                              </span>
                              {fallback}
                            </DropdownMenu.RadioItem>
                            {lifetimeChoices(lifetime).map(([h, label]) => (
                              <DropdownMenu.RadioItem key={h} value={String(h)} className={cn(menuItem, "flex gap-2")}>
                                <span className="w-3.5">
                                  <DropdownMenu.ItemIndicator>
                                    <Check className="size-3.5" />
                                  </DropdownMenu.ItemIndicator>
                                </span>
                                {label}
                              </DropdownMenu.RadioItem>
                            ))}
                          </DropdownMenu.RadioGroup>
                          <DropdownMenu.Item
                            onSelect={() => setTimeout(() => setCustomizing(true))}
                            className={cn(menuItem, "ps-7.5")}
                          >
                            Custom…
                          </DropdownMenu.Item>
                          <p className="max-w-52 px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
                            Conversations idle longer than this are deleted.
                          </p>
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                    <DropdownMenu.Separator className="my-1 h-px bg-border" />
                    <DropdownMenu.Item disabled={first} onSelect={() => void folderStore.nudge(f.id, -1)} className={menuItem}>
                      Move up
                    </DropdownMenu.Item>
                    <DropdownMenu.Item disabled={last} onSelect={() => void folderStore.nudge(f.id, 1)} className={menuItem}>
                      Move down
                    </DropdownMenu.Item>
                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger className={cn(menuItem, "flex justify-between gap-3")}>
                        Move to… <ChevronRight className="size-3.5" aria-hidden />
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent sideOffset={4} className={cn(menuContent, "max-h-72 overflow-y-auto")}>
                          <DropdownMenu.Item
                            disabled={!parent}
                            onSelect={() => void folderStore.moveInto(f.id, null)}
                            className={menuItem}
                          >
                            Top level
                          </DropdownMenu.Item>
                          {moveTargets.map((x) => (
                            <DropdownMenu.Item
                              key={x.id}
                              onSelect={() => void folderStore.moveInto(f.id, x.id)}
                              className={cn(menuItem, "flex items-center gap-2")}
                            >
                              <FolderGlyph starred={false} icon={x.icon} className="text-muted-foreground" />
                              <span className="truncate">{folderPath(x.id, fstate.folders)}</span>
                            </DropdownMenu.Item>
                          ))}
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                    <DropdownMenu.Separator className="my-1 h-px bg-border" />
                    {f.children.length === 0 ? (
                      <DropdownMenu.Item
                        onSelect={() => {
                          if (count === 0 || window.confirm(`Delete "${f.name}"? Its ${count} conversation(s) move to ${parent ? parent.name : "Recent"}.`))
                            void folderStore.remove(f.id);
                        }}
                        className={cn(menuItem, "text-destructive data-[highlighted]:bg-destructive/10")}
                      >
                        Delete folder
                      </DropdownMenu.Item>
                    ) : (
                      <DropdownMenu.Sub>
                        <DropdownMenu.SubTrigger className={cn(menuItem, "flex justify-between gap-3 text-destructive")}>
                          Delete folder <ChevronRight className="size-3.5" aria-hidden />
                        </DropdownMenu.SubTrigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.SubContent sideOffset={4} className={menuContent}>
                            <DropdownMenu.Item onSelect={() => void folderStore.remove(f.id)} className={menuItem}>
                              Keep what's inside
                              <span className="block text-xs text-muted-foreground">
                                Moves it up to {parent ? parent.name : "the top level"}
                              </span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              onSelect={() => {
                                const n = everything.filter((r) => r.depth === 0).length;
                                if (window.confirm(`Delete "${f.name}" and its subfolders? Their ${n} conversation(s) move to Recent.`))
                                  void folderStore.remove(f.id, true);
                              }}
                              className={cn(menuItem, "text-destructive data-[highlighted]:bg-destructive/10")}
                            >
                              Delete subfolders too
                              <span className="block text-xs text-muted-foreground">Conversations move to Recent</span>
                            </DropdownMenu.Item>
                          </DropdownMenu.SubContent>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Sub>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </span>
        </div>
        {shown.length > 0 || kids.length > 0 || open ? (
          <div className="ms-[10px] border-s border-sidebar-border ps-0.5">
            {open && f.rows.length === 0 && f.children.length === 0 && !addingSub && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {f.starred ? "Star a conversation to pin it here." : "Drag conversations here."}
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
            {kids.map((c, i) => (
              <FolderSectionView
                key={c.id}
                section={c}
                parent={f}
                first={i === 0}
                last={i === f.children.length - 1}
                closed={!open}
                searching={searching}
                currentId={currentId}
                labelMode={labelMode}
              />
            ))}
            {addingSub && (
              <FolderNameInput
                label="New subfolder name"
                onDone={(name) => {
                  setAddingSub(false);
                  if (name) void folderStore.create(name, f.id);
                }}
              />
            )}
          </div>
        ) : null}
      </DropZone>
    </div>
  );
}

/** An inline folder-name field; Enter or blur commits, Escape cancels. */
function FolderNameInput({ label, onDone }: { label: string; onDone: (name: string) => void }) {
  return (
    <input
      autoFocus
      placeholder="Folder name"
      aria-label={label}
      onBlur={(e) => onDone(e.currentTarget.value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.currentTarget.value = "";
          e.currentTarget.blur();
        }
      }}
      className="ms-1.5 h-7 w-[calc(100%-0.375rem)] rounded-md border border-input bg-background px-2 text-[13px]"
    />
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
    <FolderNameInput
      label="New folder name"
      onDone={(name) => {
        setEditing(false);
        if (name) void folderStore.create(name);
      }}
    />
  );
}

// List scroll offset, surviving the remount each conversation switch causes.
let listScrollTop = 0;

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
  const userIds = folderSections.filter((f) => !f.starred).map((f) => f.id);
  const searching = query.trim() !== "" || providerFilter.length > 0;
  const [filtersOpen, setFiltersOpen] = useState(false);

  // On mobile the sidebar is an overlay drawer; close it when the conversation changes
  // to reveal the thread.
  const drawer = useDrawer();
  useEffect(() => {
    mobileNav.close();
  }, [currentId]);

  // Restore before paint so the list never flashes at top.
  const listRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listScrollTop;
  }, []);

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
        "desk:static desk:h-full desk:w-72 desk:max-w-none desk:translate-x-0 desk:shadow-none desk:transition-none",
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

      <nav
        ref={listRef}
        data-testid="session-list"
        onScroll={(e) => (listScrollTop = e.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto px-2 pb-2"
      >
        {rows.length === 0 && (
          <p data-testid="session-empty" className="px-3 py-2 text-sm text-muted-foreground">
            No chats match.
          </p>
        )}
        {folderSections
          .filter((f) => !searching || allRows(f).length > 0)
          .map((f) => (
            <FolderSectionView
              key={f.id}
              section={f}
              first={f.id === userIds[0]}
              last={f.id === userIds.at(-1)}
              searching={searching}
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
