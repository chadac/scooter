// The Details tab beside a board: everything about the open card, and its edits.
//
// Description, priority and blockers come from /kanban/conversation/<id>/details; the stage,
// note and tags are the board's, passed in, so the tab and the card never disagree.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Lock, Pencil, Plus, ShieldCheck, X } from "lucide-react";
import {
  Button,
  cn,
  conversationApi,
  inputClass,
  LinkedResourcesPanel,
  Markdown,
  SourceBadge,
  Spinner,
  textareaClass,
  useContribChanges,
  type ViewConversation,
} from "@/src/contrib/sdk";

const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
type Priority = (typeof PRIORITIES)[number];
const PRIORITY_LABEL: Record<Priority, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};
const MAX_BLOCKER_MATCHES = 8;

/** A card that waits on another, or is waited on; done means in the last stage. */
interface Related {
  id: string;
  title: string;
  stage: string;
  done: boolean;
}

/** A check the card must pass to leave its stage, and where it stands on it. */
export interface GateRow {
  id: string;
  name: string;
  kind: "approval" | "command";
  command: string;
  workdir: string;
  /** command: passed | failed; approval: pending | approved | rejected; "" before any. */
  state: string;
  /** A failed command's output, or the user's comment. */
  detail: string;
  commit: string;
  updated_at: string;
}

const GATE_STATE: Record<string, { label: string; className: string }> = {
  "": { label: "Not checked", className: "text-muted-foreground" },
  passed: { label: "Passed", className: "text-green-700 dark:text-green-400" },
  failed: { label: "Failed", className: "text-destructive" },
  pending: { label: "Waiting for you", className: "text-amber-700 dark:text-amber-400" },
  approved: { label: "Approved", className: "text-green-700 dark:text-green-400" },
  rejected: { label: "Rejected", className: "text-destructive" },
};

function GateItem({ gate, decide }: { gate: GateRow; decide(approve: boolean, comment: string): Promise<boolean> }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const state = GATE_STATE[gate.state] ?? GATE_STATE[""];
  const answer = async (approve: boolean) => {
    setBusy(true);
    if (await decide(approve, comment)) setComment("");
    setBusy(false);
  };
  return (
    <li
      data-testid="kanban-gate"
      data-gate-kind={gate.kind}
      data-gate-state={gate.state || undefined}
      className={cn("flex flex-col gap-1 rounded-md border px-2 py-1.5", gate.state === "pending" && "border-amber-500/60")}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={gate.name}>
          {gate.name}
        </span>
        <span data-testid="kanban-gate-state" className={cn("shrink-0 text-[11px]", state.className)}>
          {state.label}
        </span>
      </div>
      <span className="truncate text-[11px] text-muted-foreground" title={gate.command}>
        {gate.kind === "command" ? (
          <>
            <code>{gate.command}</code>
            {gate.workdir ? ` in ${gate.workdir}` : ""}
            {gate.commit ? ` · ${gate.commit.slice(0, 12)}` : ""}
          </>
        ) : (
          "Your approval"
        )}
      </span>
      {gate.detail && (gate.state === "failed" ? (
        <pre data-testid="kanban-gate-output" className="max-h-40 overflow-auto rounded bg-muted p-1.5 text-[11px] whitespace-pre-wrap">
          {gate.detail}
        </pre>
      ) : (
        <p className="text-xs">“{gate.detail}”</p>
      ))}
      {gate.kind === "approval" && gate.state !== "approved" && (
        <div className="flex flex-col gap-1">
          <input
            aria-label={`Comment on ${gate.name}`}
            data-testid="kanban-gate-comment"
            className={inputClass}
            placeholder={gate.state === "pending" ? "Comment (sent to the agent)" : "Approve ahead of time, or leave a comment"}
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
          />
          <div className="flex gap-1">
            <Button size="sm" data-testid="kanban-gate-approve" disabled={busy} onClick={() => void answer(true)}>
              <Check aria-hidden /> Approve
            </Button>
            <Button size="sm" variant="outline" data-testid="kanban-gate-reject" disabled={busy || !comment.trim()} onClick={() => void answer(false)}>
              <X aria-hidden /> Reject
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

interface DetailsRow {
  description: string;
  priority: Priority;
  updated_by: string;
  updated_at: string;
  blocked_by: Related[];
  blocking: Related[];
  /** The gates on the card's stage. */
  gates?: GateRow[];
}

/** High and Urgent, as a card on the board marks them; nothing for the rest. */
export function PriorityMark({ priority }: { priority?: string }) {
  if (priority !== "high" && priority !== "urgent") return null;
  return (
    <span
      data-testid="kanban-card-priority"
      data-priority={priority}
      title={`${PRIORITY_LABEL[priority]} priority`}
      className={cn(
        "shrink-0 rounded px-1 text-[10px] font-semibold uppercase leading-4",
        priority === "urgent" ? "bg-red-500/15 text-red-700 dark:text-red-300" : "bg-orange-500/15 text-orange-700 dark:text-orange-300",
      )}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function RelatedRow({
  card,
  conv,
  open,
  remove,
}: {
  card: Related;
  conv?: ViewConversation;
  open(id: string): void;
  remove?: () => void;
}) {
  // The board's title is live, unlike the loaded one.
  const title = conv?.title || card.title || card.id;
  const changes = (conv?.links ?? []).filter((l) => l.resourceType === "pull_request" || l.resourceType === "merge_request");
  return (
    <li data-testid="kanban-related" data-conversation-id={card.id} data-done={card.done || undefined} className="rounded-md border px-2 py-1.5">
      <div className="flex items-start gap-2">
        <button type="button" className="min-w-0 flex-1 text-start" onClick={() => open(card.id)} title={title}>
          <span className={cn("line-clamp-2 text-sm", card.done && "text-muted-foreground line-through")}>{title}</span>
          <span className="text-[11px] text-muted-foreground">
            {card.stage}
            {card.done ? " · done" : ""}
          </span>
        </button>
        {remove && (
          <Button size="icon-xs" variant="ghost" aria-label={`Remove blocker ${title}`} data-testid="kanban-remove-blocker" onClick={remove}>
            <X aria-hidden />
          </Button>
        )}
      </div>
      {changes.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {changes.map((l, i) => (
            <li key={`${l.url ?? l.title}-${i}`}>
              <a
                href={l.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <SourceBadge source={l.source} size={12} />
                <span className="truncate">{l.title || l.url}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function AddBlocker({ choices, add }: { choices: ViewConversation[]; add(id: string): void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const q = query.trim().toLowerCase();
  const matches = choices.filter((c) => !q || c.title.toLowerCase().includes(q)).slice(0, MAX_BLOCKER_MATCHES);
  if (!open)
    return (
      <Button size="sm" variant="ghost" className="self-start" data-testid="kanban-add-blocker" disabled={choices.length === 0} onClick={() => setOpen(true)}>
        <Plus aria-hidden /> Add a blocker
      </Button>
    );
  return (
    <div className="flex flex-col gap-1">
      <input
        autoFocus
        aria-label="Find a card on this board"
        data-testid="kanban-blocker-search"
        className={inputClass}
        placeholder="Find a card on this board"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && matches[0]) {
            add(matches[0].id);
            setOpen(false);
          }
        }}
      />
      <ul className="flex flex-col">
        {matches.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              data-testid="kanban-blocker-choice"
              className="w-full truncate rounded px-2 py-1 text-start text-sm hover:bg-accent"
              onClick={() => {
                add(c.id);
                setOpen(false);
              }}
            >
              {c.title}
            </button>
          </li>
        ))}
        {matches.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">No card matches.</li>}
      </ul>
    </div>
  );
}

function Description({ text, save }: { text: string; save(next: string): Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null)
    return text ? (
      <div className="flex flex-col gap-1">
        <div
          data-testid="kanban-description"
          className="cursor-text rounded-md p-1 hover:bg-accent/50"
          // A click on a link follows it; anywhere else edits.
          onClick={(e) => !(e.target as HTMLElement).closest("a") && setDraft(text)}
        >
          <Markdown text={text} />
        </div>
        <Button size="sm" variant="ghost" className="self-start" data-testid="kanban-description-edit-button" onClick={() => setDraft(text)}>
          <Pencil aria-hidden /> Edit
        </Button>
      </div>
    ) : (
      <Button size="sm" variant="ghost" className="self-start" data-testid="kanban-description-add" onClick={() => setDraft("")}>
        <Plus aria-hidden /> Add a description
      </Button>
    );
  return (
    <textarea
      autoFocus
      aria-label="Description"
      data-testid="kanban-description-edit"
      className={cn(textareaClass, "min-h-32 font-sans")}
      placeholder="What this card is for, in markdown"
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
      onBlur={() => {
        const next = draft;
        if (next === text) return setDraft(null);
        void save(next).then((ok) => ok && setDraft(null));
      }}
    />
  );
}

export function CardDetails({
  conv,
  stages,
  stage,
  note,
  updated,
  tagField,
  board,
  move,
  open,
  changed,
}: {
  conv: ViewConversation;
  stages: Array<{ id: string; label: string }>;
  stage: string;
  note?: string;
  /** Who set the status last, and when, as the card shows it. */
  updated: string;
  tagField: ReactNode;
  /** This board's cards. */
  board: ViewConversation[];
  move(column: string): void;
  open(id: string): void;
  /** Called after an edit the card on the board shows: priority and blockers. */
  changed(): void;
}) {
  const id = conv.id;
  const [row, setRow] = useState<DetailsRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(id);
  live.current = id;

  const load = useCallback(async () => {
    const res = await conversationApi("kanban", id, "details").catch(() => null);
    if (live.current !== id) return;
    if (!res?.ok) return setError("Could not load the card's details.");
    setRow((await res.json()) as DetailsRow);
  }, [id]);
  useEffect(() => {
    setRow(null);
    setError(null);
    void load();
  }, [load]);
  // Any card's change may be a blocker of this one.
  useContribChanges("kanban", () => void load());

  const call = async (path: string, method: string, json: unknown, what: string) => {
    const res = await conversationApi("kanban", id, path, { method, json }).catch(() => null);
    if (live.current !== id) return false;
    if (!res?.ok) {
      const detail = res ? ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail : null;
      setError(`Could not ${what}${detail ? `: ${detail}` : ". Try again."}`);
      return false;
    }
    setError(null);
    return true;
  };
  const edit = async (patch: Partial<Pick<DetailsRow, "description" | "priority">>, what: string) => {
    const ok = await call("details", "PATCH", patch, what);
    if (ok) {
      await load();
      changed();
    }
    return ok;
  };
  const setBlockers = async (ids: string[], what: string) => {
    if (await call("card/blockers", "PUT", { blocked_by: ids }, what)) {
      await load();
      changed();
    }
  };

  const decide = async (gate: GateRow, approve: boolean, comment: string) => {
    const ok = await call(`gates/${gate.id}`, "PUT", { decision: approve ? "approve" : "reject", comment }, approve ? "approve it" : "reject it");
    if (ok) {
      await load();
      changed();
    }
    return ok;
  };

  if (!row)
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
        {error ?? <Spinner />}
      </div>
    );
  const blockedBy = row.blocked_by.map((b) => b.id);
  const choices = board.filter((c) => c.id !== id && !blockedBy.includes(c.id));
  const find = (cid: string) => board.find((c) => c.id === cid);
  return (
    <div data-testid="kanban-details" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Section title="Status" testId="kanban-details-status">
        <select
          aria-label="Stage"
          data-testid="kanban-details-stage"
          className={cn(inputClass, "self-start")}
          value={stage}
          onChange={(e) => move(e.currentTarget.value)}
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {note && <p className="text-sm">{note}</p>}
        <p className="text-[11px] text-muted-foreground">{updated}</p>
      </Section>
      {(row.gates ?? []).length > 0 && (
        <Section title="Gates to move on" testId="kanban-details-gates">
          <p className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <ShieldCheck aria-hidden className="size-3" /> The agent can move the card on once these pass; your own moves skip them.
          </p>
          <ul className="flex flex-col gap-1">
            {(row.gates ?? []).map((g) => (
              <GateItem key={g.id} gate={g} decide={(approve, comment) => decide(g, approve, comment)} />
            ))}
          </ul>
        </Section>
      )}
      <Section title="Priority">
        <select
          aria-label="Priority"
          data-testid="kanban-details-priority"
          className={cn(inputClass, "self-start")}
          value={row.priority}
          onChange={(e) => void edit({ priority: e.currentTarget.value as Priority }, "change the priority")}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      </Section>
      <Section title="Tags">{tagField}</Section>
      <Section title="Description">
        <Description key={id} text={row.description} save={(description) => edit({ description }, "save the description")} />
      </Section>
      <Section title="Blocked by" testId="kanban-details-blocked-by">
        {row.blocked_by.some((b) => !b.done) && (
          <p className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <Lock aria-hidden className="size-3" /> It can't move on until these are done.
          </p>
        )}
        {row.blocked_by.length > 0 && (
          <ul className="flex flex-col gap-1">
            {row.blocked_by.map((b) => (
              <RelatedRow
                key={b.id}
                card={b}
                conv={find(b.id)}
                open={open}
                remove={() => void setBlockers(blockedBy.filter((x) => x !== b.id), "remove the blocker")}
              />
            ))}
          </ul>
        )}
        <AddBlocker key={blockedBy.join(",")} choices={choices} add={(b) => void setBlockers([...blockedBy, b], "add the blocker")} />
      </Section>
      {row.blocking.length > 0 && (
        <Section title="Blocking" testId="kanban-details-blocking">
          <ul className="flex flex-col gap-1">
            {row.blocking.map((b) => (
              <RelatedRow key={b.id} card={b} conv={find(b.id)} open={open} />
            ))}
          </ul>
        </Section>
      )}
      {conv.links.length > 0 && (
        <div className="-mx-3">
          <LinkedResourcesPanel key={id} links={conv.links} />
        </div>
      )}
    </div>
  );
}
