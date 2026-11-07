// The /boards view: folders the user opted in as kanban boards, each conversation a card.
//
// /boards lists the boards; /boards/<folderId> shows one, with the chat of the open card
// beside it. Boards and columns come from /kanban/user/boards, each card's column from its
// conversation's relay. Moving a card saves it, then tells that conversation as the user.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Button,
  ChatPanel,
  cn,
  contribFetch,
  conversationApi,
  createFolder,
  EmptyState,
  ErrorState,
  inputClass,
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

interface Column {
  id: string;
  label: string;
}

interface CardRow {
  column: string;
  position: number;
  note: string;
  updated_by: "agent" | "user";
  updated_at: string;
}

interface CardView {
  card: CardRow | null;
  column: string;
}

// Agents move their own cards, and nothing pushes that here.
const POLL_MS = 15_000;
const CARD_MIME = "application/x-scooter-kanban-card";

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

/** The user's boards and the deployment's columns, with calls to change which folders are boards. */
function useBoards() {
  const [state, setState] = useState<{ boards: string[]; columns: Column[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const call = useCallback(async (path: string, method = "GET") => {
    const res = await contribFetch("kanban", path, { method });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setState((await res.json()) as { boards: string[]; columns: Column[] });
  }, []);
  useEffect(() => {
    call("boards").catch((e: unknown) => setError(String((e as Error)?.message ?? e)));
  }, [call]);
  return {
    boards: state?.boards ?? null,
    columns: state?.columns ?? [],
    error,
    add: (folder: string) => call(`boards/${encodeURIComponent(folder)}`, "PUT"),
    remove: (folder: string) => call(`boards/${encodeURIComponent(folder)}`, "DELETE"),
  };
}

export default function BoardsView() {
  const { path, navigate } = useViewRoute();
  const folders = useFolders();
  const conversations = useConversations();
  const { boards, columns, error, add, remove } = useBoards();

  if (error && !boards) return <ErrorState variant="boxed" title="Boards failed to load." error={error} />;
  if (!boards) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner /> Loading boards…
      </div>
    );
  }
  const boardFolders = boards.map((id) => folders.find((f) => f.id === id)).filter((f): f is ViewFolder => !!f);
  const current = boardFolders.find((f) => f.id === path);
  if (current) {
    return (
      <Board
        key={current.id}
        folder={current}
        boards={boardFolders}
        columns={columns}
        conversations={conversations.filter((c) => c.folderId === current.id)}
        navigate={navigate}
        remove={() => void remove(current.id).then(() => navigate(""))}
      />
    );
  }
  return (
    <BoardList
      boards={boardFolders}
      others={folders.filter((f) => !boards.includes(f.id))}
      conversations={conversations}
      open={navigate}
      add={async (folder) => {
        await add(folder);
        navigate(folder);
      }}
    />
  );
}

function BoardList({
  boards,
  others,
  conversations,
  open,
  add,
}: {
  boards: ViewFolder[];
  others: ViewFolder[];
  conversations: ViewConversation[];
  open(folder: string): void;
  add(folder: string): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    const id = await createFolder(n);
    if (id) await add(id).catch(() => setError("Could not make it a board."));
    else setError("A folder with that name already exists.");
    setBusy(false);
  };
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6" data-testid="kanban-boards">
      <h1 className="text-xl font-semibold">Boards</h1>
      {boards.length === 0 ? (
        <EmptyState title="No boards yet." description="Start one below, or turn one of your folders into a board." />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {boards.map((b) => {
            const cards = conversations.filter((c) => c.folderId === b.id);
            return (
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
            );
          })}
        </ul>
      )}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">New board</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
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
      {others.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Turn a folder into a board</h2>
          <ul className="flex flex-wrap gap-2">
            {others.map((f) => (
              <li key={f.id}>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="kanban-make-board"
                  data-folder-id={f.id}
                  onClick={() => void add(f.id)}
                >
                  {f.name}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Board({
  folder,
  boards,
  columns,
  conversations,
  navigate,
  remove,
}: {
  folder: ViewFolder;
  boards: ViewFolder[];
  columns: Column[];
  conversations: ViewConversation[];
  navigate(path: string): void;
  remove(): void;
}) {
  const [cards, setCards] = useState<Record<string, CardView>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ column: string; before?: string } | null>(null);
  const [panel, setPanel] = useState(false);
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

  const first = columns[0]?.id ?? "";
  const lanes = useMemo(() => {
    const out: Record<string, ViewConversation[]> = Object.fromEntries(columns.map((c) => [c.id, []]));
    for (const conv of conversations) {
      const col = cards[conv.id]?.column;
      out[col && out[col] ? col : first]?.push(conv);
    }
    const pos = (id: string) => cards[id]?.card?.position ?? 0;
    for (const lane of Object.values(out)) lane.sort((a, b) => pos(a.id) - pos(b.id) || b.lastActivityAt - a.lastActivityAt);
    return out;
  }, [columns, conversations, cards, first]);

  // Board order, for stepping through cards with the chat open.
  const order = useMemo(() => columns.flatMap((c) => lanes[c.id] ?? []), [columns, lanes]);
  const at = order.findIndex((c) => c.id === openId);
  const showing = panel && (at >= 0 || openId === null);
  const step = (by: -1 | 1) => {
    const next = order[at + by];
    if (next) openConversation(next.id);
  };

  const move = useCallback(
    async (id: string, column: string, before?: string) => {
      const from = cards[id]?.column ?? first;
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
        return { column, card: { note: "", ...old, ...by, column, position: at } as CardRow };
      };
      const prev = cards;
      setCards((p) => ({
        ...p,
        ...Object.fromEntries(shifts.map(([cid, at]) => [cid, placed(cid, at, false)])),
        [id]: placed(id, position, from !== column),
      }));
      const put = (cid: string, at: number) =>
        conversationApi("kanban", cid, "card", { method: "PUT", json: { column, position: at } })
          .then((r) => r.ok)
          .catch(() => false);
      const ok = (await Promise.all([put(id, position), ...shifts.map(([cid, at]) => put(cid, at))])).every(Boolean);
      if (!live.current) return;
      if (!ok) {
        setCards(prev);
        setError("Could not move the card. Try again.");
        return;
      }
      setError(null);
      if (from !== column) {
        const label = (cid: string) => columns.find((c) => c.id === cid)?.label ?? cid;
        void send(id, `I moved this card from **${label(from)}** to **${label(column)}** on the "${folder.name}" board.`);
      }
    },
    [cards, lanes, columns, first, folder.name],
  );

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
        <div className="ms-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="kanban-new"
            onClick={() => {
              newConversation({ folderId: folder.id });
              setPanel(true);
            }}
          >
            New conversation
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="kanban-remove-board"
            onClick={() => window.confirm(`Stop showing "${folder.name}" as a board? The folder stays.`) && remove()}
          >
            Remove board
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="px-4 pt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        {conversations.length === 0 && !showing ? (
          <EmptyState
            className="flex-1"
            title="No conversations on this board yet."
            description="Start one here, or file conversations into this folder from the chat view."
          />
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto p-4">
            {columns.map((col) => (
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
                <header className="flex items-center justify-between px-3 py-2 text-sm font-medium">
                  <span>{col.label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{lanes[col.id]?.length ?? 0}</span>
                </header>
                <ol className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pt-1 pb-2">
                  {(lanes[col.id] ?? []).map((conv) => {
                    const card = cards[conv.id]?.card;
                    const open = showing && conv.id === openId;
                    return (
                      <li
                        key={conv.id}
                        data-testid="kanban-card"
                        data-conversation-id={conv.id}
                        data-open={open || undefined}
                        draggable
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
                          "rounded-md border bg-background p-2 text-sm shadow-xs",
                          open && "ring-2 ring-primary",
                          dragging === conv.id && "opacity-50",
                          dropAt?.before === conv.id && "border-t-2 border-t-primary",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            openConversation(conv.id);
                            setPanel(true);
                          }}
                          className="flex w-full items-start gap-2 text-start"
                          title={conv.title}
                        >
                          {conv.dot && <StatusDot dot={conv.dot} />}
                          <span className="line-clamp-2 font-medium">{conv.title}</span>
                        </button>
                        {card?.note && (
                          <p data-testid="kanban-card-note" className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                            {card.note}
                          </p>
                        )}
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {card ? `${card.updated_by === "agent" ? "Agent" : "You"} · ${ago(card.updated_at)}` : "No status yet"}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}
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
            <div className="min-h-0 flex-1">
              <ChatPanel />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
