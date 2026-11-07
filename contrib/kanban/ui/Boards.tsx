// The /boards view: kanban boards, each conversation a card.
//
// A board is a locked folder only kanban changes, and each of its stages a locked folder inside
// it, so a card's stage is the folder its conversation is filed in. /boards lists the boards;
// /boards/<folderId> shows one, with the chat of the open card beside it. Boards and stages come
// from /kanban/user/boards, each card's note and order from its conversation's relay. Moving a
// card files the conversation in the stage, then tells it as the user.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Lock, Pencil, Plus, Tag as TagIcon, Trash2, X } from "lucide-react";
import {
  Button,
  ChatPanel,
  cn,
  contribFetch,
  conversationApi,
  EmptyState,
  ErrorState,
  inputClass,
  moveToFolder,
  newConversation,
  openConversation,
  openInChat,
  send,
  Spinner,
  StatusDot,
  useConversations,
  useFolders,
  useOpenConversation,
  useViewRoute,
  type ViewConversation,
  type ViewFolder,
} from "@/src/contrib/sdk";
import { CardDetails, PriorityMark } from "./Details.js";

interface Stage {
  id: string;
  label: string;
  position: number;
}

interface Tag {
  id: string;
  name: string;
  color: string;
  position: number;
}

interface BoardRow {
  folder: string;
  stages: Stage[];
  tags: Tag[];
}

interface CardRow {
  column: string;
  position: number;
  note: string;
  updated_by: "agent" | "user";
  updated_at: string;
}

/** A card this one waits on; done means in the last stage. */
interface BlockerRow {
  id: string;
  title: string;
  stage: string;
  done: boolean;
}

interface CardView {
  card: CardRow | null;
  blockers?: BlockerRow[];
  // Ids from any board; only this board's show.
  tags?: string[];
  priority?: string;
}

// Agents move their own cards, and nothing pushes that here.
const POLL_MS = 15_000;
const CARD_MIME = "application/x-scooter-kanban-card";
const MAX_CARD_TAGS = 5;
// `tagging` while the Details tab's tag field is open.
const DETAILS_TAGS = "details";

// Literal class strings, so Tailwind sees each palette key's classes.
const TAG_CLASS: Record<string, string> = {
  gray: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  orange: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  yellow: "bg-yellow-500/20 text-yellow-800 dark:text-yellow-200",
  green: "bg-green-500/15 text-green-700 dark:text-green-300",
  teal: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  purple: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
};
const TAG_COLORS = Object.keys(TAG_CLASS);

function TagChip({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) {
  return (
    <span
      data-testid="kanban-tag"
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium",
        TAG_CLASS[tag.color] ?? TAG_CLASS.gray,
      )}
    >
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${tag.name}`}
          // Keep focus in the field; the button unmounts on click.
          onMouseDown={(e) => e.preventDefault()}
          className="-me-0.5 rounded-sm px-0.5 leading-none opacity-70 hover:opacity-100"
          onClick={onRemove}
        >
          <X aria-hidden className="size-3" />
        </button>
      )}
    </span>
  );
}

type TagOption = { tag: Tag; name?: undefined } | { tag?: undefined; name: string };

/** A card's tags as removable chips, with a field that filters the board's tags to add. */
function TagInput({
  tags,
  chosen,
  change,
  create,
  close,
}: {
  tags: Tag[];
  chosen: Tag[];
  change(ids: string[]): void;
  // Adds a tag to the board; its id, or null when that failed.
  create(name: string): Promise<string | null>;
  close(): void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const ids = chosen.map((t) => t.id);
  const q = query.trim().toLowerCase();
  const full = chosen.length >= MAX_CARD_TAGS;
  const options: TagOption[] = full
    ? []
    : [
        ...tags.filter((t) => !ids.includes(t.id) && t.name.toLowerCase().includes(q)).map((tag) => ({ tag })),
        ...(q && !tags.some((t) => t.name.toLowerCase() === q) ? [{ name: query.trim() }] : []),
      ];
  const at = Math.min(active, options.length - 1);
  const pick = async (o: TagOption) => {
    setQuery("");
    setActive(0);
    const id = o.tag ? o.tag.id : await create(o.name);
    if (id) change([...ids, id]);
  };
  return (
    <div
      className="mt-1"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close();
      }}
    >
      <div data-testid="kanban-tag-input" className="flex flex-wrap items-center gap-1 rounded-md border border-input bg-background p-1">
        {chosen.map((t) => (
          <TagChip key={t.id} tag={t} onRemove={() => change(ids.filter((x) => x !== t.id))} />
        ))}
        <input
          autoFocus
          role="combobox"
          aria-label="Add a tag"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-activedescendant={options.length > 0 ? `${listId}-${at}` : undefined}
          className="min-w-16 flex-1 bg-transparent px-1 text-xs outline-none"
          placeholder={full ? `${MAX_CARD_TAGS} tags at most` : "Add a tag…"}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const by = e.key === "ArrowDown" ? 1 : -1;
              setActive((at + by + options.length) % Math.max(options.length, 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (options[at]) void pick(options[at]);
            } else if (e.key === "Escape") {
              close();
            } else if (e.key === "Backspace" && !query && ids.length) {
              change(ids.slice(0, -1));
            }
          }}
        />
      </div>
      {options.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Tags" className="mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {options.map((o, i) => (
            <li
              key={o.tag?.id ?? "create"}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === at}
              // Keep focus in the field, so the click lands before blur closes it.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => void pick(o)}
              className={cn("cursor-pointer rounded px-1.5 py-1 text-xs", i === at && "bg-accent")}
            >
              {o.tag ? <TagChip tag={o.tag} /> : <>Create “{o.name}”</>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function updatedLine(card: CardRow | null | undefined): string {
  return card ? `${card.updated_by === "agent" ? "Agent" : "You"} · ${ago(card.updated_at)}` : "No status yet";
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** A position strictly between two neighbours; either may be missing. */
function between(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

interface BoardsReply {
  boards: BoardRow[];
  folder?: string;
}

/** The user's boards and their stages, with calls that change them. */
function useBoards() {
  const [state, setState] = useState<BoardsReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const call = useCallback(async (path: string, method = "GET", json?: unknown) => {
    const res = await contribFetch("kanban", path, { method, json });
    const body = (await res.json().catch(() => ({}))) as BoardsReply & { detail?: string };
    // kanban passes the router's reason through, e.g. a name already taken.
    if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
    setState(body);
    return body;
  }, []);
  useEffect(() => {
    call("boards").catch((e: unknown) => setError(String((e as Error)?.message ?? e)));
  }, [call]);
  const board = (folder: string) => `boards/${encodeURIComponent(folder)}`;
  const stage = (folder: string, id: string) => `${board(folder)}/stages/${encodeURIComponent(id)}`;
  const tag = (folder: string, id: string) => `${board(folder)}/tags/${encodeURIComponent(id)}`;
  return {
    boards: state?.boards ?? null,
    error,
    create: async (name: string) => (await call("boards", "POST", { name })).folder ?? "",
    rename: (folder: string, name: string) => call(board(folder), "PATCH", { name }),
    remove: (folder: string) => call(board(folder), "DELETE"),
    stages: {
      add: (folder: string, name: string) => call(`${board(folder)}/stages`, "POST", { name }),
      update: (folder: string, id: string, patch: { name?: string; position?: number }) =>
        call(stage(folder, id), "PATCH", patch),
      remove: (folder: string, id: string) => call(stage(folder, id), "DELETE"),
    },
    tags: {
      add: (folder: string, name: string) => call(`${board(folder)}/tags`, "POST", { name }),
      update: (folder: string, id: string, patch: { name?: string; color?: string; position?: number }) =>
        call(tag(folder, id), "PATCH", patch),
      remove: (folder: string, id: string) => call(tag(folder, id), "DELETE"),
    },
  };
}

type StageCalls = ReturnType<typeof useBoards>["stages"];
type TagCalls = ReturnType<typeof useBoards>["tags"];

/** Whether a conversation is filed on a board: in its folder or one of its stages. */
const onBoard = (row: BoardRow, conv: ViewConversation) =>
  conv.folderId === row.folder || row.stages.some((s) => s.id === conv.folderId);

export default function BoardsView() {
  const { path, navigate } = useViewRoute();
  const folders = useFolders();
  const conversations = useConversations();
  const { boards, error, create, rename, remove, stages, tags } = useBoards();

  if (error && !boards) return <ErrorState variant="boxed" title="Boards failed to load." error={error} />;
  if (!boards) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner /> Loading boards…
      </div>
    );
  }
  const shown = boards.flatMap((row) => {
    const folder = folders.find((f) => f.id === row.folder);
    return folder ? [{ row, folder }] : [];
  });
  const current = shown.find((b) => b.folder.id === path);
  if (current) {
    return (
      <Board
        key={current.folder.id}
        folder={current.folder}
        stages={current.row.stages}
        tags={current.row.tags ?? []}
        boards={shown.map((b) => b.folder)}
        conversations={conversations.filter((c) => onBoard(current.row, c))}
        navigate={navigate}
        rename={(name) => rename(current.folder.id, name)}
        remove={() => remove(current.folder.id).then(() => navigate(""))}
        stageCalls={stages}
        tagCalls={tags}
      />
    );
  }
  if (boards.some((b) => b.folder === path)) {
    // A board just made: its folder reaches the sidebar a moment later.
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner /> Loading board…
      </div>
    );
  }
  return (
    <BoardList
      boards={shown.map(({ row, folder }) => ({ folder, count: conversations.filter((c) => onBoard(row, c)) }))}
      open={navigate}
      create={async (name) => navigate(await create(name))}
    />
  );
}

function BoardList({
  boards,
  open,
  create,
}: {
  boards: Array<{ folder: ViewFolder; count: ViewConversation[] }>;
  open(folder: string): void;
  create(name: string): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    await create(n).catch((e: unknown) => setError(`Could not make the board: ${(e as Error).message}`));
    setBusy(false);
  };
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6" data-testid="kanban-boards">
      <h1 className="text-xl font-semibold">Boards</h1>
      {boards.length === 0 ? (
        <EmptyState title="No boards yet." description="Start one below, then file conversations into its stages." />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {boards.map(({ folder: b, count: cards }) => (
            <li key={b.id}>
              <button
                type="button"
                data-testid="kanban-board-link"
                data-folder-id={b.id}
                onClick={() => open(b.id)}
                className="w-full rounded-lg border bg-card p-4 text-start hover:bg-accent/50"
              >
                <div className="font-medium">{b.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {cards.length} conversation{cards.length === 1 ? "" : "s"}
                  {cards.some((c) => c.running) && " · agent working"}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">New board</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            aria-label="Board name"
            data-testid="kanban-new-board-name"
            className={cn(inputClass, "min-w-0 flex-1")}
            placeholder="Name, e.g. Infra"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Button type="submit" size="sm" disabled={busy || !name.trim()} data-testid="kanban-new-board">
            Create
          </Button>
        </form>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </section>
    </div>
  );
}

function Board({
  folder,
  stages,
  tags,
  boards,
  conversations,
  navigate,
  rename,
  remove,
  stageCalls,
  tagCalls,
}: {
  folder: ViewFolder;
  stages: Stage[];
  tags: Tag[];
  boards: ViewFolder[];
  conversations: ViewConversation[];
  navigate(path: string): void;
  rename(name: string): Promise<unknown>;
  remove(): Promise<unknown>;
  stageCalls: StageCalls;
  tagCalls: TagCalls;
}) {
  const [cards, setCards] = useState<Record<string, CardView>>({});
  // Local moves, shown until the folder update arrives.
  const [pending, setPending] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ column: string; before?: string } | null>(null);
  const [panel, setPanel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [newStage, setNewStage] = useState("");
  const [newTag, setNewTag] = useState("");
  // The card whose tag field is open.
  const [tagging, setTagging] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "details">("chat");
  const openId = useOpenConversation();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const idsKey = conversations.map((c) => c.id).join(",");
  const loadCard = useCallback(async (id: string) => {
    const res = await conversationApi("kanban", id, "card");
    if (!res.ok) return;
    const v = (await res.json()) as CardView;
    if (live.current) setCards((prev) => ({ ...prev, [id]: v }));
  }, []);
  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    const load = () => void Promise.all(ids.map((id) => loadCard(id).catch(() => undefined)));
    load();
    const timer = setInterval(() => document.visibilityState === "visible" && load(), POLL_MS);
    return () => clearInterval(timer);
  }, [idsKey, loadCard]);

  useEffect(() => {
    setPending((p) => {
      const left = Object.fromEntries(
        Object.entries(p).filter(([id, stage]) => conversations.find((c) => c.id === id)?.folderId !== stage),
      );
      return Object.keys(left).length === Object.keys(p).length ? p : left;
    });
  }, [conversations]);

  const first = stages[0]?.id ?? "";
  const stageOf = useCallback(
    (conv: ViewConversation) => {
      const at = pending[conv.id] ?? conv.folderId ?? "";
      return stages.some((s) => s.id === at) ? at : first;
    },
    [pending, stages, first],
  );
  const lanes = useMemo(() => {
    const out: Record<string, ViewConversation[]> = Object.fromEntries(stages.map((s) => [s.id, []]));
    for (const conv of conversations) out[stageOf(conv)]?.push(conv);
    const pos = (id: string) => cards[id]?.card?.position ?? 0;
    for (const lane of Object.values(out)) lane.sort((a, b) => pos(a.id) - pos(b.id) || b.lastActivityAt - a.lastActivityAt);
    return out;
  }, [stages, conversations, cards, stageOf]);

  // Board order, for stepping through cards with the chat open.
  const order = useMemo(() => stages.flatMap((s) => lanes[s.id] ?? []), [stages, lanes]);
  const at = order.findIndex((c) => c.id === openId);
  const showing = panel && (at >= 0 || openId === null);
  const openConv = at >= 0 ? order[at] : undefined;
  // A new conversation has no card yet, so it shows its chat.
  const shownTab = openConv ? tab : "chat";
  const step = (by: -1 | 1) => {
    const next = order[at + by];
    if (next) openConversation(next.id);
  };

  const move = useCallback(
    async (id: string, column: string, before?: string) => {
      const conv = conversations.find((c) => c.id === id);
      const from = conv ? stageOf(conv) : first;
      const lane = (lanes[column] ?? []).filter((c) => c.id !== id);
      const idx = before ? Math.max(0, lane.findIndex((c) => c.id === before)) : lane.length;
      const pos = (c: ViewConversation) => cards[c.id]?.card?.position ?? 0;
      // Tied positions can't hold a drop between them, so renumber the lane in its shown order.
      const tied = lane.some((c, i) => i > 0 && pos(c) <= pos(lane[i - 1]));
      const position = tied ? idx : between(lane[idx - 1] && pos(lane[idx - 1]), lane[idx] && pos(lane[idx]));
      const shifts: Array<[string, number]> = tied
        ? [...lane.slice(0, idx), undefined, ...lane.slice(idx)].flatMap((c, i) => (c && pos(c) !== i ? [[c.id, i]] : []))
        : [];
      // As the server does: a move is the user's update, a reorder keeps who updated last.
      const now = new Date().toISOString();
      const placed = (cid: string, at: number, moved: boolean): CardView => {
        const old = cards[cid]?.card;
        const by = moved || !old ? { updated_by: "user", updated_at: now } : {};
        return { ...cards[cid], card: { note: "", ...old, ...by, column, position: at } as CardRow };
      };
      const prev = { cards, pending };
      setCards((p) => ({
        ...p,
        ...Object.fromEntries(shifts.map(([cid, at]) => [cid, placed(cid, at, false)])),
        [id]: placed(id, position, from !== column),
      }));
      if (from !== column) setPending((p) => ({ ...p, [id]: column }));
      const put = (cid: string, at: number) =>
        conversationApi("kanban", cid, "card", { method: "PUT", json: { column, position: at } })
          .then((r) => r.ok)
          .catch(() => false);
      // File the conversation in the stage's folder first.
      const filed = from === column || (await moveToFolder(id, column).catch(() => false));
      const ok = filed && (await Promise.all([put(id, position), ...shifts.map(([cid, at]) => put(cid, at))])).every(Boolean);
      if (!live.current) return;
      if (!ok) {
        setCards(prev.cards);
        setPending(prev.pending);
        setError("Could not move the card. Try again.");
        return;
      }
      setError(null);
      if (from !== column) {
        const label = (sid: string) => stages.find((s) => s.id === sid)?.label ?? sid;
        void send(id, `I moved this card from **${label(from)}** to **${label(column)}** on the "${folder.name}" board.`);
      }
    },
    [cards, pending, lanes, stages, first, folder.name, conversations, stageOf],
  );

  const tagsOf = useCallback(
    (id: string) => {
      const on = new Set(cards[id]?.tags ?? []);
      return tags.filter((t) => on.has(t.id));
    },
    [cards, tags],
  );

  const setTags = useCallback(
    async (id: string, next: string[]) => {
      const prev = cards[id];
      setCards((p) => ({ ...p, [id]: { ...p[id], card: p[id]?.card ?? null, tags: next } }));
      const ok = await conversationApi("kanban", id, "card/tags", { method: "PUT", json: { tags: next } })
        .then((r) => r.ok)
        .catch(() => false);
      if (!live.current) return;
      if (!ok) {
        setCards((p) => ({ ...p, [id]: prev ?? { card: null } }));
        setError("Could not change the card's tags. Try again.");
        return;
      }
      setError(null);
    },
    [cards],
  );

  const createTag = async (name: string) => {
    try {
      const reply = await tagCalls.add(folder.id, name);
      setError(null);
      const row = reply.boards.find((b) => b.folder === folder.id);
      return row?.tags.find((t) => t.name === name)?.id ?? null;
    } catch (e) {
      setError(`Could not add the tag: ${(e as Error).message}`);
      return null;
    }
  };

  const shiftTag = (i: number, by: -1 | 1) => {
    const [a, b] = by < 0 ? [tags[i - 2], tags[i - 1]] : [tags[i + 1], tags[i + 2]];
    const position = between(a?.position, b?.position);
    void changeBoard(tagCalls.update(folder.id, tags[i].id, { position }), "move the tag");
  };

  const changeBoard = (work: Promise<unknown>, what: string) =>
    work.then(
      () => setError(null),
      (e: unknown) => setError(`Could not ${what}: ${(e as Error).message}`),
    );
  const shiftStage = (i: number, by: -1 | 1) => {
    // Position between the neighbours on the target side.
    const [a, b] = by < 0 ? [stages[i - 2], stages[i - 1]] : [stages[i + 1], stages[i + 2]];
    const position = between(a?.position, b?.position);
    void changeBoard(stageCalls.update(folder.id, stages[i].id, { position }), "move the stage");
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="kanban-board" data-folder-id={folder.id}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button size="sm" variant="ghost" data-testid="kanban-all-boards" onClick={() => navigate("")}>
          <ArrowLeft aria-hidden /> Boards
        </Button>
        <select
          aria-label="Board"
          data-testid="kanban-switch-board"
          value={folder.id}
          onChange={(e) => navigate(e.currentTarget.value)}
          className={cn(inputClass, "py-1 font-semibold")}
        >
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="kanban-new"
            onClick={() => {
              newConversation({ folderId: first || folder.id });
              setPanel(true);
            }}
          >
            New conversation
          </Button>
          <Button
            size="sm"
            variant={editing ? "secondary" : "ghost"}
            data-testid="kanban-edit-stages"
            aria-pressed={editing}
            onClick={() => setEditing((e) => !e)}
          >
            {editing ? "Done editing" : "Edit board"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="kanban-rename-board"
            onClick={() => {
              const name = window.prompt("Rename the board", folder.name)?.trim();
              if (name && name !== folder.name) {
                rename(name).catch((e: unknown) => setError(`Could not rename the board: ${(e as Error).message}`));
              }
            }}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="kanban-delete-board"
            onClick={() => {
              const ok = window.confirm(`Delete the "${folder.name}" board and its stages? Its conversations stay, unfiled.`);
              if (ok) remove().catch((e: unknown) => setError(`Could not delete the board: ${(e as Error).message}`));
            }}
          >
            Delete board
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="px-4 pt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {editing && (
        <section data-testid="kanban-tags" aria-label="Tags" className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <h2 className="text-xs font-medium text-muted-foreground">Tags</h2>
          {tags.length === 0 && <span className="text-xs text-muted-foreground">None yet. You and the agent can put these on cards.</span>}
          {tags.map((t, i) => (
            <span key={t.id} data-testid="kanban-tag-tools" className="flex items-center gap-0.5 rounded border ps-1">
              <TagChip tag={t} />
              <select
                aria-label={`Color of ${t.name}`}
                value={t.color}
                onChange={(e) =>
                  void changeBoard(tagCalls.update(folder.id, t.id, { color: e.currentTarget.value }), "recolor the tag")
                }
                className="bg-transparent text-[11px]"
              >
                {TAG_COLORS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <Button size="icon-xs" variant="ghost" aria-label={`Move ${t.name} left`} disabled={i === 0} onClick={() => shiftTag(i, -1)}>
                <ChevronLeft aria-hidden />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Move ${t.name} right`}
                disabled={i === tags.length - 1}
                onClick={() => shiftTag(i, 1)}
              >
                <ChevronRight aria-hidden />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Rename ${t.name}`}
                onClick={() => {
                  const name = window.prompt("Rename the tag", t.name)?.trim();
                  if (name && name !== t.name) void changeBoard(tagCalls.update(folder.id, t.id, { name }), "rename the tag");
                }}
              >
                <Pencil aria-hidden />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Delete ${t.name}`}
                onClick={() => {
                  const uses = conversations.filter((c) => cards[c.id]?.tags?.includes(t.id)).length;
                  const ask = uses ? `Remove "${t.name}" from ${uses} card${uses === 1 ? "" : "s"} and delete it?` : `Delete the "${t.name}" tag?`;
                  if (!window.confirm(ask)) return;
                  // Drop it locally too, so the cards don't wait for the next poll.
                  setCards((p) =>
                    Object.fromEntries(Object.entries(p).map(([id, v]) => [id, { ...v, tags: v.tags?.filter((x) => x !== t.id) }])),
                  );
                  void changeBoard(tagCalls.remove(folder.id, t.id), "delete the tag");
                }}
              >
                <Trash2 aria-hidden />
              </Button>
            </span>
          ))}
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newTag.trim();
              if (!name) return;
              void changeBoard(tagCalls.add(folder.id, name).then(() => setNewTag("")), "add the tag");
            }}
          >
            <input
              aria-label="New tag name"
              data-testid="kanban-new-tag-name"
              className={cn(inputClass, "w-36 py-1 text-xs")}
              placeholder="New tag, e.g. bug"
              maxLength={24}
              value={newTag}
              onChange={(e) => setNewTag(e.currentTarget.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={!newTag.trim()}>
              <Plus aria-hidden /> Add tag
            </Button>
          </form>
        </section>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto p-4">
          {stages.map((col, i) => (
            <section
              key={col.id}
              data-testid="kanban-lane"
              data-column={col.id}
              aria-label={col.label}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                if (dropAt?.column !== col.id || dropAt.before) setDropAt({ column: col.id });
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(CARD_MIME) || dragging;
                e.preventDefault();
                setDragging(null);
                setDropAt(null);
                if (id) void move(id, col.id, dropAt?.column === col.id ? dropAt.before : undefined);
              }}
              className={cn(
                "flex w-64 shrink-0 flex-col rounded-lg bg-muted/40",
                dropAt?.column === col.id && !dropAt.before && "ring-2 ring-primary/50",
              )}
            >
              <header className="flex items-center justify-between gap-1 px-3 py-2 text-sm font-medium">
                <span className="truncate">{col.label}</span>
                {editing ? (
                  <span className="flex shrink-0 items-center" data-testid="kanban-stage-tools">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Move ${col.label} left`}
                      disabled={i === 0}
                      onClick={() => shiftStage(i, -1)}
                    >
                      <ChevronLeft aria-hidden />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Move ${col.label} right`}
                      disabled={i === stages.length - 1}
                      onClick={() => shiftStage(i, 1)}
                    >
                      <ChevronRight aria-hidden />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Rename ${col.label}`}
                      data-testid="kanban-rename-stage"
                      onClick={() => {
                        const name = window.prompt("Rename the stage", col.label)?.trim();
                        if (name && name !== col.label) {
                          void changeBoard(stageCalls.update(folder.id, col.id, { name }), "rename the stage");
                        }
                      }}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${col.label}`}
                      data-testid="kanban-delete-stage"
                      disabled={stages.length <= 1}
                      onClick={() => {
                        const to = (i === 0 ? stages[1] : stages[0])?.label;
                        if (window.confirm(`Delete the "${col.label}" stage? Its cards move to "${to}".`)) {
                          void changeBoard(stageCalls.remove(folder.id, col.id), "delete the stage");
                        }
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </span>
                ) : (
                  <span className="text-xs tabular-nums text-muted-foreground">{lanes[col.id]?.length ?? 0}</span>
                )}
              </header>
              <ol className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pt-1 pb-2">
                {i === 0 && !editing && (
                  <li
                    onDragOver={(e) => {
                      // A drop on the tile goes to the top of the lane.
                      const top = lanes[col.id]?.[0]?.id;
                      if (!dragging || !top || top === dragging) return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (dropAt?.before !== top) setDropAt({ column: col.id, before: top });
                    }}
                  >
                    <button
                      type="button"
                      data-testid="kanban-stage-new"
                      aria-label={`New conversation in ${col.label}`}
                      onClick={() => {
                        newConversation({ folderId: col.id });
                        setPanel(true);
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:bg-background hover:text-foreground"
                    >
                      <Plus aria-hidden className="size-3.5" /> New conversation
                    </button>
                  </li>
                )}
                {(lanes[col.id] ?? []).map((conv) => {
                  const card = cards[conv.id]?.card;
                  const waiting = (cards[conv.id]?.blockers ?? []).filter((b) => !b.done);
                  const cardTags = tagsOf(conv.id);
                  const open = showing && conv.id === openId;
                  return (
                    <li
                      key={conv.id}
                      data-testid="kanban-card"
                      data-conversation-id={conv.id}
                      data-open={open || undefined}
                      data-blocked={waiting.length > 0 || undefined}
                      draggable={tagging !== conv.id}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(CARD_MIME, conv.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragging(conv.id);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setDropAt(null);
                      }}
                      onDragOver={(e) => {
                        if (!dragging || dragging === conv.id) return;
                        e.preventDefault();
                        e.stopPropagation();
                        if (dropAt?.before !== conv.id) setDropAt({ column: col.id, before: conv.id });
                      }}
                      className={cn(
                        "group rounded-md border bg-background p-2 text-sm shadow-xs",
                        open && "ring-2 ring-primary",
                        waiting.length > 0 && "border-dashed bg-muted/40",
                        dragging === conv.id && "opacity-50",
                        dropAt?.before === conv.id && "border-t-2 border-t-primary",
                      )}
                    >
                      <div className="flex items-start gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            openConversation(conv.id);
                            setPanel(true);
                          }}
                          className="flex min-w-0 flex-1 items-start gap-2 text-start"
                          title={conv.title}
                        >
                          {conv.dot && <StatusDot dot={conv.dot} />}
                          <span className="line-clamp-2 font-medium">{conv.title}</span>
                          <PriorityMark priority={cards[conv.id]?.priority} />
                        </button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Edit tags"
                          aria-expanded={tagging === conv.id}
                          data-testid="kanban-edit-card-tags"
                          // Keep focus in the open field, so this click closes it.
                          onMouseDown={(e) => e.preventDefault()}
                          className={cn(
                            "shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
                            tagging === conv.id && "opacity-100",
                          )}
                          onClick={() => setTagging((t) => (t === conv.id ? null : conv.id))}
                        >
                          <TagIcon aria-hidden />
                        </Button>
                      </div>
                      {tagging !== conv.id && cardTags.length > 0 && (
                        <ul data-testid="kanban-card-tags" className="mt-1 flex flex-wrap gap-1" aria-label="Tags">
                          {cardTags.map((t) => (
                            <li key={t.id} className="max-w-full">
                              <TagChip tag={t} />
                            </li>
                          ))}
                        </ul>
                      )}
                      {tagging === conv.id && (
                        <TagInput
                          tags={tags}
                          chosen={cardTags}
                          change={(ids) => void setTags(conv.id, ids)}
                          create={createTag}
                          close={() => setTagging(null)}
                        />
                      )}
                      {card?.note && (
                        <p data-testid="kanban-card-note" className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                          {card.note}
                        </p>
                      )}
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>{updatedLine(card)}</span>
                        {waiting.length > 0 && (
                          <span
                            data-testid="kanban-blocked-by"
                            className="ms-auto inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400"
                          >
                            <Lock aria-hidden className="size-3" />
                            Blocked by {waiting.length}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {editing && (
            <form
              data-testid="kanban-add-stage"
              className="flex w-64 shrink-0 flex-col gap-2 self-start rounded-lg border border-dashed p-3"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newStage.trim();
                if (!name) return;
                void changeBoard(
                  stageCalls.add(folder.id, name).then(() => setNewStage("")),
                  "add the stage",
                );
              }}
            >
              <input
                aria-label="New stage name"
                data-testid="kanban-new-stage-name"
                className={cn(inputClass, "min-w-0")}
                placeholder="New stage, e.g. Backlog"
                value={newStage}
                onChange={(e) => setNewStage(e.currentTarget.value)}
              />
              <Button type="submit" size="sm" variant="outline" disabled={!newStage.trim()}>
                <Plus aria-hidden /> Add stage
              </Button>
            </form>
          )}
        </div>
        {showing && (
          <aside data-testid="kanban-chat" className="flex w-[min(42rem,50%)] shrink-0 flex-col border-s">
            <div className="flex items-center gap-1 border-b px-2 py-1.5 text-xs">
              <Button size="sm" variant="ghost" data-testid="kanban-prev" disabled={at <= 0} onClick={() => step(-1)}>
                <ChevronLeft aria-hidden /> Previous
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="kanban-next"
                disabled={at < 0 || at >= order.length - 1}
                onClick={() => step(1)}
              >
                Next <ChevronRight aria-hidden />
              </Button>
              <span className="ms-auto" />
              {openId && (
                <Button size="sm" variant="ghost" data-testid="kanban-open-in-chat" onClick={() => openInChat(openId)}>
                  Open in chat
                </Button>
              )}
              <Button size="sm" variant="ghost" data-testid="kanban-close-chat" onClick={() => setPanel(false)}>
                Close
              </Button>
            </div>
            <div role="tablist" aria-label="Card" className="flex gap-1 border-b px-2 text-sm">
              {(["chat", "details"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  data-testid={`kanban-tab-${t}`}
                  aria-selected={shownTab === t}
                  disabled={t === "details" && !openConv}
                  onClick={() => setTab(t)}
                  className={cn(
                    "-mb-px border-b-2 px-2 py-1.5 disabled:opacity-50",
                    shownTab === t ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t === "chat" ? "Chat" : "Details"}
                </button>
              ))}
            </div>
            {/* Hidden, not unmounted, so the draft and scroll survive a switch. */}
            <div role="tabpanel" className={cn("min-h-0 flex-1", shownTab !== "chat" && "hidden")}>
              <ChatPanel />
            </div>
            {shownTab === "details" && openConv && (
              <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
                <CardDetails
                  key={openConv.id}
                  conv={openConv}
                  stages={stages}
                  stage={stageOf(openConv)}
                  note={cards[openConv.id]?.card?.note}
                  updated={updatedLine(cards[openConv.id]?.card)}
                  board={order}
                  move={(column) => void move(openConv.id, column)}
                  open={openConversation}
                  changed={() => void loadCard(openConv.id).catch(() => undefined)}
                  tagField={
                    tagging === DETAILS_TAGS ? (
                      <TagInput
                        tags={tags}
                        chosen={tagsOf(openConv.id)}
                        change={(ids) => void setTags(openConv.id, ids)}
                        create={createTag}
                        close={() => setTagging(null)}
                      />
                    ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        {tagsOf(openConv.id).map((t) => (
                          <TagChip key={t.id} tag={t} />
                        ))}
                        <Button size="sm" variant="ghost" data-testid="kanban-details-edit-tags" onClick={() => setTagging(DETAILS_TAGS)}>
                          <TagIcon aria-hidden /> {tagsOf(openConv.id).length ? "Edit" : "Add tags"}
                        </Button>
                      </div>
                    )
                  }
                />
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
