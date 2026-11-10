// The /boards view: kanban boards, each conversation a card.
//
// A board is a locked folder only kanban changes, and each of its stages a locked folder inside
// it, so a card's stage is the folder its conversation is filed in. /boards lists the boards;
// /boards/<folderId> shows one, with the chat of the open card beside it. Boards and stages come
// from /kanban/user/boards. Each lane shows its most recent cards, more as it scrolls, read
// with POST /kanban/user/boards/<id>/cards and again when kanban pushes a change to them. Moving a card files the
// conversation in the stage, then tells it as the user.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Lock, Pencil, Plus, ShieldCheck, Tag as TagIcon, Trash2, X } from "lucide-react";
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
  setThreadInUrl,
  Spinner,
  StatusDot,
  threadInUrl,
  useContribChanges,
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

/** A note the user writes for every agent on the board; each gets it as a skill. */
interface Skill {
  id: string;
  name: string;
  body: string;
  position: number;
}

/** A check a card must pass before its agent moves it on from `stage`. */
interface Gate {
  id: string;
  /** The stage's id. */
  stage: string;
  kind: "approval" | "command";
  name: string;
  position: number;
  command: string;
  /** A directory under /workspace, e.g. "scooter". */
  workdir: string;
  /** Run on a clean checkout of the last commit. */
  clean: boolean;
  timeout_seconds: number;
}

interface BoardRow {
  folder: string;
  stages: Stage[];
  tags: Tag[];
  skills?: Skill[];
  gates?: Gate[];
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
  /** Ids of the approval gates the agent asked the user for. */
  awaiting?: string[];
}

const CARD_MIME = "application/x-scooter-kanban-card";
const MAX_CARD_TAGS = 5;
// As kanban's boards.py allows.
const MAX_BOARD_SKILLS = 10;
const MAX_SKILL_NAME_CHARS = 60;
const MAX_SKILL_CHARS = 4000;
const MAX_BOARD_GATES = 20;
const MAX_GATE_NAME_CHARS = 60;
// `tagging` while the Details tab's tag field is open.
const DETAILS_TAGS = "details";
// Cards a lane shows at first, and adds per scroll.
const LANE_PAGE = 50;
const MAX_READ_CARDS = 200;
// Scrolling this close to a lane's end shows its next page.
const SCROLL_SLACK_PX = 200;

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

/** The first palette color the fewest tags have, as kanban picks one for a new tag. */
const pickColor = (used: string[]) =>
  TAG_COLORS.reduce((best, c) => (used.filter((u) => u === c).length < used.filter((u) => u === best).length ? c : best));

/**
 * A card's tags as removable chips, with a field that filters the board's tags to add.
 *
 * Changes stay here until the field closes, then `commit` gets them once: the kept ids,
 * and the names of tags to make.
 */
function TagInput({
  tags,
  chosen,
  commit,
  close,
}: {
  tags: Tag[];
  chosen: Tag[];
  commit(ids: string[], create: string[]): void;
  close(): void;
}) {
  const [picked, setPicked] = useState(chosen);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  // Every way of closing unmounts the field, so commit then.
  const latest = useRef({ picked, commit });
  latest.current = { picked, commit };
  const initial = useRef(chosen.map((t) => t.id).join(","));
  useEffect(
    () => () => {
      const { picked, commit } = latest.current;
      if (picked.map((t) => t.id).join(",") === initial.current) return;
      commit(
        picked.filter((t) => !isNew(t.id)).map((t) => t.id),
        picked.filter((t) => isNew(t.id)).map((t) => t.name),
      );
    },
    [],
  );
  const ids = picked.map((t) => t.id);
  const q = query.trim().toLowerCase();
  const full = picked.length >= MAX_CARD_TAGS;
  const named = (name: string) => [...tags, ...picked].some((t) => t.name.toLowerCase() === name);
  const options: TagOption[] = full
    ? []
    : [
        ...tags.filter((t) => !ids.includes(t.id) && t.name.toLowerCase().includes(q)).map((tag) => ({ tag })),
        ...(q && !named(q) ? [{ name: query.trim() }] : []),
      ];
  const at = Math.min(active, options.length - 1);
  const pick = (o: TagOption) => {
    setQuery("");
    setActive(0);
    const used = [...tags, ...picked.filter((t) => isNew(t.id))].map((t) => t.color);
    setPicked((p) => [...p, o.tag ?? { id: `${NEW}${o.name}`, name: o.name, color: pickColor(used), position: 0 }]);
  };
  const drop = (id: string) => setPicked((p) => p.filter((t) => t.id !== id));
  return (
    <div
      className="mt-1"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close();
      }}
    >
      <div data-testid="kanban-tag-input" className="flex flex-wrap items-center gap-1 rounded-md border border-input bg-background p-1">
        {picked.map((t) => (
          <TagChip key={t.id} tag={t} onRemove={() => drop(t.id)} />
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
              if (options[at]) pick(options[at]);
            } else if (e.key === "Escape") {
              close();
            } else if (e.key === "Backspace" && !query && ids.length) {
              drop(ids[ids.length - 1]);
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
              onClick={() => pick(o)}
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

/** A lane's `limit` most recent cards, in board order. */
export function pageLane<C extends { id: string; lastActivityAt: number }>(
  lane: C[],
  limit: number,
  recent: (c: C) => number,
  position: (id: string) => number,
): C[] {
  return [...lane]
    .sort((a, b) => recent(b) - recent(a))
    .slice(0, limit)
    .sort((a, b) => position(a.id) - position(b.id) || b.lastActivityAt - a.lastActivityAt);
}

/** A position strictly between two neighbours; either may be missing. */
/**
 * The gates a move from stage `from` to `to` passes, as the broker counts them: every
 * gate on the stages it leaves behind, so a jump past a stage owes that stage's too. A
 * move back, or within a stage, passes none.
 */
export function gatesOnTheWay<G extends { stage: string }>(stages: Array<{ id: string }>, gates: G[], from: string, to: string): G[] {
  const at = stages.findIndex((s) => s.id === from);
  const until = stages.findIndex((s) => s.id === to);
  if (at < 0 || until <= at) return [];
  const left = new Set(stages.slice(at, until).map((s) => s.id));
  return gates.filter((g) => left.has(g.stage));
}

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

/** A failed kanban call; `status` tells a refusal (4xx) from a partial save (5xx). */
class CallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A board's stages, tags and skills while Edit board is open; new ones have ids from `newId`. */
interface Draft {
  stages: Stage[];
  tags: Tag[];
  skills: Skill[];
  gates: Gate[];
}

const NEW = "new:";
let made = 0;
const newId = () => `${NEW}${++made}`;
const isNew = (id: string) => id.startsWith(NEW);

/** The PUT body saving a draft: the board's stages, tags and skills as they should end up. */
const draftBody = ({ stages, tags, skills, gates }: Draft) => ({
  stages: stages.map((s) => (isNew(s.id) ? { name: s.label } : { id: s.id, name: s.label })),
  tags: tags.map((t) => (isNew(t.id) ? { name: t.name, color: t.color } : { id: t.id, name: t.name, color: t.color })),
  skills: skills.map((k) => (isNew(k.id) ? { name: k.name, body: k.body } : { id: k.id, name: k.name, body: k.body })),
  // A gate goes with its stage, and a new stage gets gates once saved.
  gates: gates
    .filter((g) => stages.some((s) => s.id === g.stage && !isNew(s.id)))
    .map(({ id, stage, kind, name, command, workdir, clean, timeout_seconds }) => ({
      ...(isNew(id) ? {} : { id }),
      stage,
      kind,
      name,
      ...(kind === "command" ? { command, workdir, clean, timeout_seconds } : {}),
    })),
});

/** The agent's name for a skill, as kanban's skill_slug makes it. */
export const skillSlug = (name: string) => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `board-${slug}`.slice(0, 64).replace(/-+$/, "") : "";
};

/** The user's boards and their stages, with calls that change them. */
function useBoards() {
  const [state, setState] = useState<BoardsReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useCallback(async <T,>(path: string, method = "GET", json?: unknown): Promise<T> => {
    const res = await contribFetch("kanban", path, { method, json });
    const body = (await res.json().catch(() => ({}))) as T & { detail?: string };
    // kanban passes the router's reason through, e.g. a name already taken.
    if (!res.ok) throw new CallError(body.detail ?? `HTTP ${res.status}`, res.status);
    return body;
  }, []);
  const call = useCallback(
    async (path: string, method = "GET", json?: unknown) => {
      const body = await request<BoardsReply>(path, method, json);
      setState(body);
      return body;
    },
    [request],
  );
  useEffect(() => {
    call("boards").catch((e: unknown) => setError(String((e as Error)?.message ?? e)));
  }, [call]);
  const board = (folder: string) => `boards/${encodeURIComponent(folder)}`;
  const putRow = (folder: string, change: (row: BoardRow) => BoardRow) =>
    setState((s) => s && { ...s, boards: s.boards.map((b) => (b.folder === folder ? change(b) : b)) });
  return {
    boards: state?.boards ?? null,
    error,
    create: async (name: string) => (await call("boards", "POST", { name })).folder ?? "",
    rename: (folder: string, name: string) => call(board(folder), "PATCH", { name }),
    remove: (folder: string) => call(board(folder), "DELETE"),
    reload: () => call("boards"),
    /** Saves a board's stages, tags and skills in one request. */
    save: async (folder: string, draft: Draft) => {
      const reply = await request<{ board: BoardRow }>(board(folder), "PUT", draftBody(draft));
      putRow(folder, () => reply.board);
    },
    /** Records tags a card's tag field made on the board. */
    addTags: (folder: string, tags: Tag[]) => putRow(folder, (row) => ({ ...row, tags: [...row.tags, ...tags] })),
  };
}

type BoardCalls = Pick<ReturnType<typeof useBoards>, "save" | "addTags" | "reload">;

/** Whether a conversation is filed on a board: in its folder or one of its stages. */
const onBoard = (row: BoardRow, conv: ViewConversation) =>
  conv.folderId === row.folder || row.stages.some((s) => s.id === conv.folderId);

export default function BoardsView() {
  const { path, navigate } = useViewRoute();
  const folders = useFolders();
  const conversations = useConversations();
  const { boards, error, create, rename, remove, save, addTags, reload } = useBoards();
  // No ids: the boards themselves changed.
  useContribChanges("kanban", (ids) => {
    if (ids.length === 0) void reload().catch(() => undefined);
  });

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
        skills={current.row.skills ?? []}
        gates={current.row.gates ?? []}
        boards={shown.map((b) => b.folder)}
        conversations={conversations.filter((c) => onBoard(current.row, c))}
        navigate={navigate}
        rename={(name) => rename(current.folder.id, name)}
        remove={() => remove(current.folder.id).then(() => navigate(""))}
        calls={{ save, addTags, reload }}
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
  stages: savedStages,
  tags: savedTags,
  skills: savedSkills,
  gates: savedGates,
  boards,
  conversations,
  navigate,
  rename,
  remove,
  calls,
}: {
  folder: ViewFolder;
  stages: Stage[];
  tags: Tag[];
  skills: Skill[];
  gates: Gate[];
  boards: ViewFolder[];
  conversations: ViewConversation[];
  navigate(path: string): void;
  rename(name: string): Promise<unknown>;
  remove(): Promise<unknown>;
  calls: BoardCalls;
}) {
  const [cards, setCards] = useState<Record<string, CardView>>({});
  // Local moves, shown until the folder update arrives.
  const [pending, setPending] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ column: string; before?: string } | null>(null);
  // A URL naming a conversation opens its chat; main.tsx selects it.
  const [panel, setPanel] = useState(() => threadInUrl() !== null);
  // Edit board's unsaved stages, tags and skills; null when not editing.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  // Where to go once the "Save changes?" prompt is answered.
  const [leaving, setLeaving] = useState<string | null>(null);
  // Tags a card's field is making, shown until saved.
  const [making, setMaking] = useState<Tag[]>([]);
  const editing = draft !== null;
  const stages = draft?.stages ?? savedStages;
  const tags = draft?.tags ?? savedTags;
  const dirty =
    draft !== null &&
    JSON.stringify(draftBody(draft)) !== JSON.stringify(draftBody({ stages: savedStages, tags: savedTags, skills: savedSkills, gates: savedGates }));
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

  // Recency when first seen, so later activity doesn't reshuffle what shows.
  const rank = useRef(new Map<string, number>());
  for (const c of conversations) if (!rank.current.has(c.id)) rank.current.set(c.id, c.lastActivityAt);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const more = (lane: string) => setLimits((l) => ({ ...l, [lane]: (l[lane] ?? LANE_PAGE) + LANE_PAGE }));

  // One reader drains the queue, at most MAX_READ_CARDS per request.
  const queue = useRef({ ids: new Set<string>(), running: false });
  const load = useCallback(
    (ids: Iterable<string>) => {
      const q = queue.current;
      for (const id of ids) q.ids.add(id);
      if (q.running) return;
      q.running = true;
      void (async () => {
        try {
          while (q.ids.size && live.current) {
            const batch = [...q.ids].slice(0, MAX_READ_CARDS);
            for (const id of batch) q.ids.delete(id);
            const res = await contribFetch("kanban", `boards/${encodeURIComponent(folder.id)}/cards`, {
              method: "POST",
              json: { conversations: batch },
            }).catch(() => null);
            const body = res?.ok ? ((await res.json().catch(() => null)) as { cards?: Record<string, CardView> } | null) : null;
            if (body?.cards && live.current) setCards((p) => ({ ...p, ...body.cards }));
          }
        } finally {
          q.running = false;
        }
      })();
    },
    [folder.id],
  );

  useEffect(() => {
    setPending((p) => {
      const left = Object.fromEntries(
        Object.entries(p).filter(([id, stage]) => conversations.find((c) => c.id === id)?.folderId !== stage),
      );
      return Object.keys(left).length === Object.keys(p).length ? p : left;
    });
  }, [conversations]);

  const first = stages[0]?.id ?? "";
  const last = stages.at(-1)?.id ?? "";
  const stageOf = useCallback(
    (conv: ViewConversation) => {
      const at = pending[conv.id] ?? conv.folderId ?? "";
      return stages.some((s) => s.id === at) ? at : first;
    },
    [pending, stages, first],
  );
  // Each lane's cards, the most recent LANE_PAGE (or more once scrolled) shown.
  const { lanes, counts } = useMemo(() => {
    const all: Record<string, ViewConversation[]> = Object.fromEntries(stages.map((s) => [s.id, []]));
    for (const conv of conversations) all[stageOf(conv)]?.push(conv);
    const recent = (c: ViewConversation) => rank.current.get(c.id) ?? c.lastActivityAt;
    const pos = (id: string) => cards[id]?.card?.position ?? 0;
    const lanes: Record<string, ViewConversation[]> = {};
    const counts: Record<string, number> = {};
    for (const [id, lane] of Object.entries(all)) {
      counts[id] = lane.length;
      lanes[id] = pageLane(lane, limits[id] ?? LANE_PAGE, recent, pos);
    }
    return { lanes, counts };
  }, [stages, conversations, cards, stageOf, limits]);

  // Read each shown card once; pushes re-read the cards they name.
  const shown = useMemo(() => Object.values(lanes).flat().map((c) => c.id), [lanes]);
  const read = useRef(new Set<string>());
  const shownKey = shown.join(",");
  useEffect(() => {
    const fresh = shownKey ? shownKey.split(",").filter((id) => !read.current.has(id)) : [];
    for (const id of fresh) read.current.add(id);
    if (fresh.length) load(fresh);
  }, [shownKey, load]);
  useContribChanges("kanban", (ids) => load(ids.length ? ids.filter((id) => read.current.has(id)) : shown));

  // A blocker is done once in the last stage, wherever it is now.
  const waitingOn = (id: string) =>
    (cards[id]?.blockers ?? []).filter((b) => {
      const conv = conversations.find((c) => c.id === b.id);
      return conv ? stageOf(conv) !== last : !b.done;
    });

  // Board order, for stepping through cards with the chat open.
  const order = useMemo(() => stages.flatMap((s) => lanes[s.id] ?? []), [stages, lanes]);
  const at = order.findIndex((c) => c.id === openId);
  const showing = panel && (at >= 0 || openId === null);
  const openConv = at >= 0 ? order[at] : undefined;
  // A new conversation has no card yet, so it shows its chat.
  const shownTab = openConv ? tab : "chat";
  // Keep ?thread= naming the shown chat, so a reload reopens it.
  useEffect(() => {
    if (showing && openId) setThreadInUrl(openId);
    else if (!panel) setThreadInUrl(null);
  }, [showing, openId, panel]);
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
      if (from !== column) {
        // Shown in its new lane, however old it is.
        rank.current.set(id, Date.now());
        setPending((p) => ({ ...p, [id]: column }));
      }
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

  // The user's move is never gated, but a move past command gates (e.g. the tests) asks
  // first whether the card's agent should make it instead, so its gate hook runs them.
  const [checking, setChecking] = useState<CheckAsk | null>(null);
  const requestMove = useCallback(
    (id: string, column: string, before?: string) => {
      const conv = conversations.find((c) => c.id === id);
      const from = conv ? stageOf(conv) : first;
      const owed = gatesOnTheWay(savedStages, savedGates, from, column);
      const commands = owed.filter((g) => g.kind === "command");
      if (commands.length === 0) return void move(id, column, before);
      setChecking({
        id,
        column,
        before,
        title: conv?.title || "This card",
        stage: stages.find((s) => s.id === column)?.label ?? column,
        commands,
        approvals: owed.filter((g) => g.kind === "approval"),
      });
    },
    [conversations, stageOf, first, savedStages, savedGates, stages, move],
  );

  const tagsOf = useCallback(
    (id: string) => {
      const on = new Set(cards[id]?.tags ?? []);
      return [...tags, ...making].filter((t) => on.has(t.id));
    },
    [cards, tags, making],
  );

  /** Saves a card's tags once its field closes, making the tags named in `create`. */
  const setTags = useCallback(
    async (id: string, ids: string[], create: string[]) => {
      const prev = cards[id];
      const pending: Tag[] = [];
      for (const name of create) {
        const color = pickColor([...tags, ...pending].map((t) => t.color));
        pending.push({ id: `${NEW}${name}`, name, color, position: 0 });
      }
      setMaking((m) => [...m, ...pending]);
      setCards((p) => ({ ...p, [id]: { ...p[id], card: p[id]?.card ?? null, tags: [...ids, ...pending.map((t) => t.id)] } }));
      const reply = await conversationApi("kanban", id, "card/tags", {
        method: "PUT",
        json: { tags: ids, board: folder.id, create },
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ tags: string[]; created: Tag[] }>) : null))
        .catch(() => null);
      if (!live.current) return;
      setMaking((m) => m.filter((t) => !pending.includes(t)));
      if (!reply) {
        setCards((p) => ({ ...p, [id]: prev ?? { card: null } }));
        setError("Could not change the card's tags. Try again.");
        return;
      }
      if (reply.created.length) calls.addTags(folder.id, reply.created);
      setCards((p) => ({ ...p, [id]: { ...p[id], card: p[id]?.card ?? null, tags: reply.tags } }));
      setError(null);
    },
    [cards, calls, folder.id, tags],
  );

  const edit = (change: (d: Draft) => Draft) => setDraft((d) => d && change(d));
  const shift = <T,>(list: T[], i: number, by: -1 | 1) => {
    const out = [...list];
    [out[i], out[i + by]] = [out[i + by], out[i]];
    return out;
  };
  const shiftTag = (i: number, by: -1 | 1) => edit((d) => ({ ...d, tags: shift(d.tags, i, by) }));
  const shiftStage = (i: number, by: -1 | 1) => edit((d) => ({ ...d, stages: shift(d.stages, i, by) }));
  const changeSkill = (id: string, patch: Partial<Skill>) =>
    edit((d) => ({ ...d, skills: d.skills.map((k) => (k.id === id ? { ...k, ...patch } : k)) }));
  const changeGate = (id: string, patch: Partial<Gate>) =>
    edit((d) => ({ ...d, gates: d.gates.map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
  const addGate = (stage: string, kind: Gate["kind"]) =>
    edit((d) => ({
      ...d,
      gates: [
        ...d.gates,
        {
          id: newId(), stage, kind, name: kind === "approval" ? "Your approval" : "", position: 0,
          command: "", workdir: "", clean: true, timeout_seconds: 600,
        },
      ],
    }));
  const changeTag = (id: string, patch: Partial<Tag>) =>
    edit((d) => ({ ...d, tags: d.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

  /** Sends the draft in one request; whether the board now matches it. */
  const saveDraft = async () => {
    if (!draft) return true;
    if (!dirty) {
      setDraft(null);
      return true;
    }
    setSaving(true);
    try {
      await calls.save(folder.id, draft);
      if (!live.current) return true;
      setDraft(null);
      setError(null);
      return true;
    } catch (e) {
      if (!live.current) return false;
      setError(`Could not save the board: ${(e as Error).message}`);
      if (e instanceof CallError && e.status >= 500) {
        // Part may have saved; restart from the stored board.
        await calls.reload().catch(() => undefined);
        if (live.current) setDraft(null);
      }
      return false;
    } finally {
      if (live.current) setSaving(false);
    }
  };

  /** Goes to `path`, asking first when the board has unsaved edits. */
  const leave = (path: string) => (dirty ? setLeaving(path) : navigate(path));

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="kanban-board" data-folder-id={folder.id}>
      <div className="flex flex-wrap items-center gap-2 border-b px-2 py-2 md:px-4">
        <Button size="sm" variant="ghost" data-testid="kanban-all-boards" aria-label="Boards" onClick={() => leave("")}>
          <ArrowLeft aria-hidden /> <span className="max-md:hidden">Boards</span>
        </Button>
        <select
          aria-label="Board"
          data-testid="kanban-switch-board"
          value={folder.id}
          onChange={(e) => leave(e.currentTarget.value)}
          className={cn(inputClass, "min-w-0 flex-1 py-1 font-semibold md:flex-none")}
        >
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <div className="ms-auto flex flex-wrap items-center gap-1 md:gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="kanban-new"
            onClick={() => {
              // A stage made in the draft has no folder yet.
              newConversation({ folderId: first && !isNew(first) ? first : folder.id });
              setPanel(true);
            }}
          >
            New conversation
          </Button>
          {dirty && (
            <>
              <span data-testid="kanban-unsaved" className="text-xs text-muted-foreground">
                Unsaved changes
              </span>
              <Button size="sm" variant="ghost" data-testid="kanban-discard" disabled={saving} onClick={() => setDraft(null)}>
                Discard
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant={dirty ? "default" : editing ? "secondary" : "ghost"}
            data-testid="kanban-edit-stages"
            aria-pressed={editing}
            disabled={saving}
            onClick={() => {
              if (editing) return void saveDraft();
              setTagging(null);
              setDraft({ stages: savedStages, tags: savedTags, skills: savedSkills, gates: savedGates });
            }}
          >
            {saving && <Spinner />}
            {dirty ? "Save" : editing ? "Done editing" : "Edit board"}
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
                onChange={(e) => changeTag(t.id, { color: e.currentTarget.value })}
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
                  if (name && name !== t.name) changeTag(t.id, { name });
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
                  if (window.confirm(ask)) edit((d) => ({ ...d, tags: d.tags.filter((x) => x.id !== t.id) }));
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
              if (tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
                setError(`This board already has a tag named "${name}".`);
                return;
              }
              const color = pickColor(tags.map((t) => t.color));
              edit((d) => ({ ...d, tags: [...d.tags, { id: newId(), name, color, position: 0 }] }));
              setNewTag("");
              setError(null);
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
      {editing && draft && (
        <section data-testid="kanban-skills" aria-label="Skills" className="space-y-2 border-b px-4 py-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">Skills</h2>
            <span className="text-xs text-muted-foreground">
              Context every agent on this board gets as a skill: conventions, where things live, how to ship.
            </span>
          </div>
          {draft.skills.map((k) => (
            <div key={k.id} data-testid="kanban-skill" className="space-y-1 rounded border p-2">
              <div className="flex items-center gap-2">
                <input
                  aria-label="Skill name"
                  data-testid="kanban-skill-name"
                  className={cn(inputClass, "min-w-0 flex-1 py-1 text-xs")}
                  placeholder="Name, e.g. Release steps"
                  maxLength={MAX_SKILL_NAME_CHARS}
                  value={k.name}
                  onChange={(e) => changeSkill(k.id, { name: e.currentTarget.value })}
                />
                {skillSlug(k.name) && (
                  <code className="shrink-0 text-[11px] text-muted-foreground" title="The agent's name for it">
                    {skillSlug(k.name)}
                  </code>
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete ${k.name || "this skill"}`}
                  onClick={() => edit((d) => ({ ...d, skills: d.skills.filter((x) => x.id !== k.id) }))}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
              <textarea
                aria-label={`Text of ${k.name || "the skill"}`}
                data-testid="kanban-skill-body"
                className={cn(inputClass, "min-h-20 w-full py-1 font-mono text-xs")}
                placeholder="Markdown the agent reads, e.g. Open PRs against develop, never main."
                maxLength={MAX_SKILL_CHARS}
                value={k.body}
                onChange={(e) => changeSkill(k.id, { body: e.currentTarget.value })}
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            data-testid="kanban-add-skill"
            disabled={draft.skills.length >= MAX_BOARD_SKILLS}
            onClick={() => edit((d) => ({ ...d, skills: [...d.skills, { id: newId(), name: "", body: "", position: 0 }] }))}
          >
            <Plus aria-hidden /> Add skill
          </Button>
        </section>
      )}
      {editing && draft && (
        <section data-testid="kanban-gates" aria-label="Gates" className="space-y-2 border-b px-4 py-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">Gates</h2>
            <span className="text-xs text-muted-foreground">
              What a card must pass before its agent moves it on from a stage. Commands run in the card's sandbox on its
              last commit; approvals ask you. Your own moves skip them.
            </span>
          </div>
          {draft.stages.map((st) => {
            const mine = draft.gates.filter((g) => g.stage === st.id);
            return (
              <div key={st.id} data-testid="kanban-stage-gates" data-stage={st.label} className="space-y-1 rounded border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">Leaving {st.label || "this stage"}</span>
                  {isNew(st.id) ? (
                    <span className="text-[11px] text-muted-foreground">Save the board to add gates to a new stage.</span>
                  ) : (
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        data-testid="kanban-add-approval-gate"
                        disabled={draft.gates.length >= MAX_BOARD_GATES}
                        onClick={() => addGate(st.id, "approval")}
                      >
                        <Plus aria-hidden /> Approval
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        data-testid="kanban-add-command-gate"
                        disabled={draft.gates.length >= MAX_BOARD_GATES}
                        onClick={() => addGate(st.id, "command")}
                      >
                        <Plus aria-hidden /> Command
                      </Button>
                    </>
                  )}
                </div>
                {mine.map((g) => (
                  <div key={g.id} data-testid="kanban-gate-edit" data-gate-kind={g.kind} className="space-y-1 rounded bg-muted/40 p-1.5">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-[11px] text-muted-foreground">{g.kind === "approval" ? "Approval" : "Command"}</span>
                      <input
                        aria-label="Gate name"
                        data-testid="kanban-gate-name"
                        className={cn(inputClass, "min-w-0 flex-1 py-1 text-xs")}
                        placeholder={g.kind === "approval" ? "Name, e.g. Design approved" : "Name, e.g. Unit tests"}
                        maxLength={MAX_GATE_NAME_CHARS}
                        value={g.name}
                        onChange={(e) => changeGate(g.id, { name: e.currentTarget.value })}
                      />
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Delete ${g.name || "this gate"}`}
                        onClick={() => edit((d) => ({ ...d, gates: d.gates.filter((x) => x.id !== g.id) }))}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                    {g.kind === "command" && (
                      <>
                        <textarea
                          aria-label={`Command for ${g.name || "the gate"}`}
                          data-testid="kanban-gate-command"
                          className={cn(inputClass, "min-h-12 w-full py-1 font-mono text-xs")}
                          placeholder="nix develop -c just test"
                          value={g.command}
                          onChange={(e) => changeGate(g.id, { command: e.currentTarget.value })}
                        />
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <label className="flex items-center gap-1">
                            /workspace/
                            <input
                              aria-label="Directory"
                              data-testid="kanban-gate-workdir"
                              className={cn(inputClass, "w-32 py-0.5 text-xs")}
                              placeholder="repo"
                              value={g.workdir}
                              onChange={(e) => changeGate(g.id, { workdir: e.currentTarget.value })}
                            />
                          </label>
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              data-testid="kanban-gate-clean"
                              checked={g.clean}
                              onChange={(e) => changeGate(g.id, { clean: e.currentTarget.checked })}
                            />
                            Clean checkout of the last commit
                          </label>
                          <label className="flex items-center gap-1">
                            Timeout
                            <input
                              type="number"
                              aria-label="Timeout in seconds"
                              className={cn(inputClass, "w-20 py-0.5 text-xs")}
                              min={10}
                              max={3600}
                              value={g.timeout_seconds}
                              onChange={(e) => changeGate(g.id, { timeout_seconds: Math.round(Number(e.currentTarget.value) || 0) })}
                            />
                            s
                          </label>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </section>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto p-4 max-md:snap-x max-md:snap-mandatory max-md:scroll-px-4",
            // Phones show the open card instead of the lanes.
            showing && "max-md:hidden",
          )}
        >
          {stages.map((col, i) => (
            <section
              key={col.id}
              data-testid="kanban-lane"
              data-column={col.id}
              aria-label={col.label}
              onDragOver={(e) => {
                // A draft stage has no folder to file into yet.
                if (!dragging || isNew(col.id)) return;
                e.preventDefault();
                if (dropAt?.column !== col.id || dropAt.before) setDropAt({ column: col.id });
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(CARD_MIME) || dragging;
                e.preventDefault();
                setDragging(null);
                setDropAt(null);
                if (id) requestMove(id, col.id, dropAt?.column === col.id ? dropAt.before : undefined);
              }}
              className={cn(
                "flex w-64 shrink-0 flex-col rounded-lg bg-muted/40 max-md:w-[85vw] max-md:snap-start",
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
                          edit((d) => ({ ...d, stages: d.stages.map((s) => (s.id === col.id ? { ...s, label: name } : s)) }));
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
                          edit((d) => ({ ...d, stages: d.stages.filter((s) => s.id !== col.id) }));
                        }
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </span>
                ) : (
                  <span className="text-xs tabular-nums text-muted-foreground">{counts[col.id] ?? 0}</span>
                )}
              </header>
              <ol
                className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pt-1 pb-2"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const hidden = (counts[col.id] ?? 0) > (lanes[col.id]?.length ?? 0);
                  if (hidden && el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_SLACK_PX) more(col.id);
                }}
              >
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
                  const waiting = waitingOn(conv.id);
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
                      // Card opens its chat; inner controls keep their clicks.
                      onClick={(e) => {
                        if (tagging === conv.id || (e.target as HTMLElement).closest("button, input, a, [role=listbox]")) return;
                        openConversation(conv.id);
                        setPanel(true);
                      }}
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
                        "group cursor-pointer rounded-md border bg-background p-2 text-sm shadow-xs",
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
                          {(cards[conv.id]?.awaiting ?? []).length > 0 && (
                            <span
                              data-testid="kanban-card-awaiting"
                              title={`Waiting for your approval: ${savedGates
                                .filter((g) => cards[conv.id]?.awaiting?.includes(g.id))
                                .map((g) => g.name)
                                .join(", ")}`}
                              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 text-[10px] font-semibold uppercase leading-4 text-amber-700 dark:text-amber-300"
                            >
                              <ShieldCheck aria-hidden className="size-3" /> Approve
                            </span>
                          )}
                        </button>
                        {!editing && (
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
                        )}
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
                          commit={(ids, create) => void setTags(conv.id, ids, create)}
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
                {(counts[col.id] ?? 0) > (lanes[col.id]?.length ?? 0) && (
                  <li>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="kanban-lane-more"
                      className="w-full text-xs text-muted-foreground"
                      onClick={() => more(col.id)}
                    >
                      Show {Math.min(LANE_PAGE, (counts[col.id] ?? 0) - (lanes[col.id]?.length ?? 0))} more
                    </Button>
                  </li>
                )}
              </ol>
            </section>
          ))}
          {editing && (
            <form
              data-testid="kanban-add-stage"
              className="flex w-64 shrink-0 flex-col gap-2 self-start rounded-lg border border-dashed p-3 max-md:w-[85vw] max-md:snap-start"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newStage.trim();
                if (!name) return;
                edit((d) => ({ ...d, stages: [...d.stages, { id: newId(), label: name, position: 0 }] }));
                setNewStage("");
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
          <aside data-testid="kanban-chat" className="flex w-full shrink-0 flex-col md:w-[min(42rem,50%)] md:border-s">
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
                  move={(column) => requestMove(openConv.id, column)}
                  open={openConversation}
                  changed={() => load([openConv.id])}
                  tagField={
                    tagging === DETAILS_TAGS ? (
                      <TagInput
                        tags={tags}
                        chosen={tagsOf(openConv.id)}
                        commit={(ids, create) => void setTags(openConv.id, ids, create)}
                        close={() => setTagging(null)}
                      />
                    ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        {tagsOf(openConv.id).map((t) => (
                          <TagChip key={t.id} tag={t} />
                        ))}
                        {!editing && (
                          <Button size="sm" variant="ghost" data-testid="kanban-details-edit-tags" onClick={() => setTagging(DETAILS_TAGS)}>
                            <TagIcon aria-hidden /> {tagsOf(openConv.id).length ? "Edit" : "Add tags"}
                          </Button>
                        )}
                      </div>
                    )
                  }
                />
              </div>
            )}
          </aside>
        )}
      </div>
      {checking && (
        <RunChecks
          ask={checking}
          move={() => {
            setChecking(null);
            void move(checking.id, checking.column, checking.before);
          }}
          cancel={() => setChecking(null)}
        />
      )}
      {leaving !== null && (
        <SaveChanges
          saving={saving}
          save={async () => {
            if (await saveDraft()) navigate(leaving);
            setLeaving(null);
          }}
          discard={() => {
            setDraft(null);
            setLeaving(null);
            navigate(leaving);
          }}
          cancel={() => setLeaving(null)}
        />
      )}
    </div>
  );
}

/** A move the user asked for that passes command gates, waiting on whether to run them. */
interface CheckAsk {
  id: string;
  column: string;
  before?: string;
  title: string;
  /** The stage it would move to, by name. */
  stage: string;
  commands: Gate[];
  approvals: Gate[];
}

type CheckPhase =
  | { at: "ask" }
  | { at: "asking" }
  | { at: "asked" }
  /** `text`: why the agent couldn't be asked. */
  | { at: "failed"; text: string };

/**
 * Asks, before the user's move past command gates, whether the card's agent should run them.
 * Ask the agent messages it to make the move itself: its kanban_set_status runs kanban's gate
 * hook in its sandbox, and the card moves once they pass. Move anyway moves it now, ungated.
 */
function RunChecks({ ask, move, cancel }: { ask: CheckAsk; move(): void; cancel(): void }) {
  const title = useId();
  const [phase, setPhase] = useState<CheckPhase>({ at: "ask" });

  const request = async () => {
    setPhase({ at: "asking" });
    try {
      const r = await conversationApi("kanban", ask.id, "card/request", { method: "POST", json: { column: ask.column } });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { detail?: string } | null;
        return setPhase({ at: "failed", text: body?.detail ?? `The agent couldn't be asked (${r.status}).` });
      }
      setPhase({ at: "asked" });
    } catch (e) {
      setPhase({ at: "failed", text: `The agent couldn't be asked: ${(e as Error).message}` });
    }
  };

  const names = (gs: Gate[]) => gs.map((g) => `"${g.name}"`).join(", ");
  const busy = phase.at === "asking";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={busy ? undefined : cancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        data-testid="kanban-run-checks"
        data-phase={phase.at}
        className="w-[28rem] max-w-[92vw] rounded-lg border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !busy && cancel()}
      >
        <h2 id={title} className="flex items-center gap-1.5 font-medium">
          <ShieldCheck className="size-4 shrink-0" aria-hidden />
          Run checks before moving to {ask.stage}?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          To move on, <span className="font-medium text-foreground">{ask.title}</span> must pass {names(ask.commands)}. The
          card's agent can run {ask.commands.length === 1 ? "it" : "them"} in its sandbox and move the card once{" "}
          {ask.commands.length === 1 ? "it passes" : "they pass"}.
          {ask.approvals.length > 0 && <> Moving it anyway counts as the approval for {names(ask.approvals)}.</>}
        </p>
        <ul className="mt-2 space-y-1 text-xs" data-testid="kanban-run-checks-gates">
          {ask.commands.map((g) => (
            <li key={g.id} className="truncate">
              <span className="font-medium">{g.name}</span>{" "}
              <code className="text-muted-foreground">
                {g.command}
                {g.workdir ? ` in ${g.workdir}` : ""}
              </code>
            </li>
          ))}
        </ul>
        {phase.at === "asked" && (
          <p className="mt-3 text-sm" role="status" data-testid="kanban-run-checks-asked">
            Asked the agent. The card moves when the checks pass; if they don't, the agent says why in the chat.
          </p>
        )}
        {phase.at === "failed" && (
          <p
            role="alert"
            data-testid="kanban-run-checks-output"
            className="mt-3 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs"
          >
            {phase.text}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {phase.at === "asked" ? (
            <Button size="sm" autoFocus onClick={cancel}>
              Done
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={move}>
                Move anyway
              </Button>
              <Button size="sm" autoFocus disabled={busy} onClick={() => void request()}>
                {busy ? <Spinner /> : null}
                Ask the agent
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Asks what to do with unsaved board edits before leaving the board. */
function SaveChanges({
  saving,
  save,
  discard,
  cancel,
}: {
  saving: boolean;
  save(): void;
  discard(): void;
  cancel(): void;
}) {
  const title = useId();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={cancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        data-testid="kanban-save-changes"
        className="w-80 rounded-lg border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && cancel()}
      >
        <h2 id={title} className="font-medium">
          Save changes?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">This board has edits that aren't saved yet.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={discard}>
            Discard
          </Button>
          <Button size="sm" autoFocus disabled={saving} onClick={save}>
            {saving && <Spinner />} Save
          </Button>
        </div>
      </div>
    </div>
  );
}
