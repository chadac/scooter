// The /boards view: kanban boards, each conversation a card.
//
// A board is a locked folder only kanban changes, and each of its stages a locked folder inside
// it, so a card's stage is the folder its conversation is filed in. /boards lists the boards;
// /boards/<folderId> shows one, with the chat of the open card beside it. Boards and stages come
// from /kanban/user/boards, each card's note and order from its conversation's relay. Moving a
// card files the conversation in the stage, then tells it as the user.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
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

interface Stage {
  id: string;
  label: string;
  position: number;
}

interface BoardRow {
  folder: string;
  stages: Stage[];
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
  };
}

type StageCalls = ReturnType<typeof useBoards>["stages"];

/** Whether a conversation is filed on a board: in its folder or one of its stages. */
const onBoard = (row: BoardRow, conv: ViewConversation) =>
  conv.folderId === row.folder || row.stages.some((s) => s.id === conv.folderId);

export default function BoardsView() {
  const { path, navigate } = useViewRoute();
  const folders = useFolders();
  const conversations = useConversations();
  const { boards, error, create, rename, remove, stages } = useBoards();

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
        boards={shown.map((b) => b.folder)}
        conversations={conversations.filter((c) => onBoard(current.row, c))}
        navigate={navigate}
        rename={(name) => rename(current.folder.id, name)}
        remove={() => remove(current.folder.id).then(() => navigate(""))}
        stageCalls={stages}
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
  boards,
  conversations,
  navigate,
  rename,
  remove,
  stageCalls,
}: {
  folder: ViewFolder;
  stages: Stage[];
  boards: ViewFolder[];
  conversations: ViewConversation[];
  navigate(path: string): void;
  rename(name: string): Promise<unknown>;
  remove(): Promise<unknown>;
  stageCalls: StageCalls;
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
        return { card: { note: "", ...old, ...by, column, position: at } as CardRow };
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

  const changeStages = (work: Promise<unknown>, what: string) =>
    work.then(
      () => setError(null),
      (e: unknown) => setError(`Could not ${what}: ${(e as Error).message}`),
    );
  const shiftStage = (i: number, by: -1 | 1) => {
    // Position between the neighbours on the target side.
    const [a, b] = by < 0 ? [stages[i - 2], stages[i - 1]] : [stages[i + 1], stages[i + 2]];
    const position = between(a?.position, b?.position);
    void changeStages(stageCalls.update(folder.id, stages[i].id, { position }), "move the stage");
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
            {editing ? "Done editing" : "Edit stages"}
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
      <div className="flex min-h-0 flex-1">
        {conversations.length === 0 && !showing && !editing ? (
          <EmptyState
            className="flex-1"
            title="No conversations on this board yet."
            description="Start one here, or file conversations into its stages from the sidebar."
          />
        ) : (
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
                            void changeStages(stageCalls.update(folder.id, col.id, { name }), "rename the stage");
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
                            void changeStages(stageCalls.remove(folder.id, col.id), "delete the stage");
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
            {editing && (
              <form
                data-testid="kanban-add-stage"
                className="flex w-64 shrink-0 flex-col gap-2 self-start rounded-lg border border-dashed p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = newStage.trim();
                  if (!name) return;
                  void changeStages(
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
