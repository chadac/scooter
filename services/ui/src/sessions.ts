/**
 * Conversation (session) store, the source of truth for the left sidebar. It holds the
 * list of conversations with titles and the current selection, backed by a small
 * useSyncExternalStore store with localStorage as the optimistic cache and the server as truth.
 */

import { useSyncExternalStore } from "react";

import type { AgentHostConfig } from "./client.js";
import { Conversation } from "./conversation.js";
import { contribLinkProviders } from "./contribManifest.js";

export interface Session {
  /** Stable local key that React, selection and the runtime mount on; it may be a placeholder the server has never seen, so address the server with `serverId`. */
  id: string;
  /** The server's conversation id (the AG-UI threadId), or undefined before creation. */
  serverId?: string;
  title: string;
  createdAt: number;
  /** Last user activity timestamp (ms epoch), used for sidebar sorting. */
  lastActivityAt: number;
  /** The model shown: an unsent pick, else the server's (undefined = host default). */
  model?: string;
  /** A picker choice not yet sent; the only model X-Agent-Model carries. */
  pendingModel?: string;
  /** Distinct linked-resource providers for the sidebar icons, server-sourced. */
  sources?: string[];
  /** Compact linked-resource summary, server-sourced, driving the label mode, keyword search and provider filter. */
  links?: SessionLink[];
  /** Creating user, server-sourced; undefined means unowned. */
  owner?: string;
  /** True once the server has created this conversation; undefined is treated as not yet created. */
  serverCreated?: boolean;
  /** The spawning conversation when this is a subagent, server-sourced. */
  parentId?: string;
  /** A child's kind, server-sourced. */
  kind?: "subagent" | "session";
  /** Where a session was started from, e.g. "vscode" or "web"; server-sourced. */
  origin?: string;
  /** The conversation's sandbox lifecycle state, server-sourced and live via the /conversations/events stream. */
  status?: "running" | "suspended" | "failed" | "ended";
  /** The user renamed this conversation, so the server title is authoritative and the agent's title never overrides it. */
  userTitled?: boolean;
  /** In the viewer's Starred folder (see setStarredKeys). */
  starred?: boolean;
  /** "private" when only its owner may see and drive it, server-sourced; absent means shared. */
  visibility?: "shared" | "private";
  /** Set while the agent is mid-turn (ms epoch), server-sourced; absent when idle. */
  runStartedAt?: number;
  /** When the agent's last turn ended (ms epoch), server-sourced. */
  lastReplyAt?: number;
  /** Set while the agent waits on the user's answer to a question or approval (ms epoch), server-sourced. */
  awaitingInputAt?: number;
  /** The lastReplyAt this browser has shown the user; local only. A reply newer than it is unread. */
  lastSeenAt?: number;
}

/** One conversation as the server describes it — a snapshot row or an upsert frame, whose id is always the SERVER id. */
export type ServerConversation = {
  id: string;
  title?: string;
  createdAt?: number;
  lastActivityAt?: number;
  model?: string;
  sources?: string[];
  links?: SessionLink[];
  owner?: string;
  status?: Session["status"];
  parentId?: string;
  kind?: "subagent" | "session";
  origin?: string;
  userTitled?: boolean;
  visibility?: "shared" | "private";
  runStartedAt?: number;
  lastReplyAt?: number;
  awaitingInputAt?: number;
};

/** What a merge may claim beyond the rows themselves: list membership, and per-row link ownership. */
export type MergeOpts = { fullList?: boolean; sourcesAuthoritative?: boolean };

/** One linked external resource, as summarized in the conversation list. */
export interface SessionLink {
  source: string; // "github" | "gitlab" | "slack" | "jira" | …
  resourceType: string; // "pull_request" | "merge_request" | "issue" | "thread" | …
  url?: string;
  title?: string;
}

/** The placeholder title, until something names the conversation. */
export const DEFAULT_TITLE = "New chat";
const STORAGE_KEY = "kubenix-agent.sessions.v1";

/** Sidebar view filter: the caller's own conversations or all of them. */
export type Scope = "mine" | "all";

/** The known link providers (the app's own plus the deployment's contribs), computed per call because the contrib manifest is fetched at runtime. */
export function linkProviders(): readonly string[] {
  return ["github", "slack", ...contribLinkProviders()];
}
export type LinkProvider = string;

/** What a sidebar row displays: the conversation title, or a specific provider's linked-resource name with the title as fallback. */
export type LabelMode = "title" | LinkProvider;

type State = {
  sessions: Session[];
  currentId: string;
  /** The caller's id from /whoami, for the Mine filter ("" until loaded). */
  currentUser: string;
  /** The caller's email from /whoami, null when unknown or anonymous. */
  currentUserEmail: string | null;
  /** True when the caller has no ingress identity. */
  currentUserAnonymous: boolean;
  /** Sidebar Mine/All toggle (default Mine). */
  scope: Scope;
  /** Keyword search over the title and linked-resource names (empty = no search). */
  query: string;
  /** Selected provider filter chips; a session matches if it links to any of them, and empty means no filter. */
  providerFilter: LinkProvider[];
  /** What rows display, persisted. */
  labelMode: LabelMode;
  /** A deep-link target (from ?thread=<id>) to select as soon as it appears in the list, cleared once selected. */
  pendingSelect?: string;
  /** The conversation whose title is being renamed inline, during which mergeFromServer does not run; transient. */
  editingId?: string;
  /** The conversation whose row actions (star/rename/delete) are under the pointer. Holds the list
   *  still like editingId does, so a reorder cannot slide a different row under a click; transient. */
  hoverId?: string;
  /** Stream frames that arrived while the rename lock held, replayed in order once it clears; transient.
   *  A frame the lock drops is lost for good, since nothing re-reads the list. Why: PR #783. */
  pendingFrames?: PendingFrame[];
};

/** One deferred stream frame: a merge with the opts it arrived with, or a removal by server id. */
type PendingFrame =
  | { kind: "merge"; convs: ServerConversation[]; opts?: MergeOpts }
  | { kind: "remove"; serverId: string };

/** A brand-new, untouched conversation (default title, no messages yet). */
const isPristine = (s: Session) => s.title === DEFAULT_TITLE;

/** Whether the server has ever created this conversation. */
const isServerBacked = (s: Session): boolean => s.serverId !== undefined || s.serverCreated === true;

/** Whether this session's first send is still creating it server-side (still titled "New chat" and id-less meanwhile). */
const isCreating = (s: Session): boolean => conversations.get(s.id)?.creating === true;

/** The id the server knows this conversation by, which is what anything server-owned (list membership, a subagent's `parentId`) must be matched against. */
export const serverKeyOf = (s: Pick<Session, "id" | "serverId">): string => s.serverId ?? s.id;

/** Whether two Session objects carry the same rendered state, so a merge can reuse the existing reference and React.memo skips the row. */
const sameSession = (a: Session, b: Session): boolean => {
  if (
    a.id !== b.id ||
    a.title !== b.title ||
    a.userTitled !== b.userTitled ||
    a.starred !== b.starred ||
    a.visibility !== b.visibility ||
    a.createdAt !== b.createdAt ||
    a.lastActivityAt !== b.lastActivityAt ||
    a.model !== b.model ||
    a.pendingModel !== b.pendingModel ||
    a.owner !== b.owner ||
    a.status !== b.status ||
    a.runStartedAt !== b.runStartedAt ||
    a.lastReplyAt !== b.lastReplyAt ||
    a.awaitingInputAt !== b.awaitingInputAt ||
    a.lastSeenAt !== b.lastSeenAt ||
    a.parentId !== b.parentId ||
    a.kind !== b.kind ||
    a.origin !== b.origin
  ) return false;
  const srcA = a.sources ?? [], srcB = b.sources ?? [];
  if (srcA.length !== srcB.length || srcA.some((v, i) => v !== srcB[i])) return false;
  const lnA = a.links ?? [], lnB = b.links ?? [];
  if (lnA.length !== lnB.length) return false;
  return lnA.every((l, i) => l.url === lnB[i].url && l.title === lnB[i].title && l.source === lnB[i].source);
};

/** Sidebar order: starred conversations first, then most recently active first within each group. */
export const byStarredThenRecent = (a: Session, b: Session): number => {
  const sa = a.starred ? 1 : 0;
  const sb = b.starred ? 1 : 0;
  if (sa !== sb) return sb - sa;
  return b.lastActivityAt - a.lastActivityAt;
};

const freshState = (): State => {
  const id = crypto.randomUUID();
  const now = Date.now();
  return {
    sessions: [{ id, title: DEFAULT_TITLE, createdAt: now, lastActivityAt: now }],
    currentId: id,
    currentUser: "",
    currentUserEmail: null,
    currentUserAnonymous: true,
    scope: "mine",
    query: "",
    providerFilter: [],
    labelMode: "title",
  };
};

/** Load persisted sessions from localStorage so the sidebar survives a refresh, falling back to a single fresh conversation. */
const loadState = (): State => {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as State;
    if (!parsed?.sessions?.length || !parsed.currentId) return freshState();
    const sessions = parsed.sessions.filter((s) => s && typeof s.id === "string");
    if (!sessions.length) return freshState();
    const currentId = sessions.some((s) => s.id === parsed.currentId)
      ? parsed.currentId
      : sessions[0].id;
    // currentUser is re-fetched via /whoami on load rather than persisted.
    return {
      sessions, currentId, currentUser: "", currentUserEmail: null,
      currentUserAnonymous: true, scope: parsed.scope === "all" ? "all" : "mine",
      // Search and provider filter are transient; the label mode persists like scope.
      query: "", providerFilter: [],
      // Any string is accepted because this module initializes before the contrib manifest lands, and an unknown mode degrades to the title.
      labelMode: typeof parsed.labelMode === "string" ? (parsed.labelMode as LabelMode) : "title",
    };
  } catch (e) {
    // Corrupt persisted state starts fresh, logged so the loss is diagnosable.
    console.warn("[sessions] persisted state unreadable; starting fresh:", e);
    return freshState();
  }
};

let state: State = loadState();
// Stars come from the folder store, never a server row.
let starredKeys: ReadonlySet<string> = new Set(state.sessions.filter((s) => s.starred).map(serverKeyOf));

const persist = (s: State) => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* localStorage unavailable (private mode / SSR) */
  }
};

/** How a new conversation gets its id: the app injects a minter that calls POST /conversations, and the UUID default keeps the store testable without a backend. */
let mintId: () => Promise<string | null> = async () => {
  // In the app this default would invent an id the server never issued, so warn loudly.
  console.warn("[sessions] mintId FELL BACK to a client UUID — setConversationMinter was not installed");
  return crypto.randomUUID();
};

/** Install the server-backed id minter. Called once at app start. */
export const setConversationMinter = (fn: () => Promise<string | null>) => {
  mintId = fn;
};

/** Runs once the server issues a new conversation's id, before the create resolves, so the first send waits for it. */
let afterCreate: (key: string, id: string) => Promise<void> = async () => {};

/** Install the post-create step: folders.ts files a conversation started in a folder before its first run reads the folder. */
export const setAfterCreate = (fn: (key: string, id: string) => Promise<void>) => {
  afterCreate = fn;
};

/** How conversations reach the server, injected once at app start. */
let agentHostConfig: AgentHostConfig = { baseUrl: "" };
export const setAgentHostConfig = (cfg: AgentHostConfig) => {
  agentHostConfig = cfg;
};

/** The Conversation object per session, keyed by the session's stable key; the Session record is the render model and this is the behavior. */
const conversations = new Map<string, Conversation>();

/** The Conversation for a session, created on first use as `pending` until it has a server id. */
export const conversationFor = (
  session: Pick<Session, "id" | "serverCreated" | "serverId">,
): Conversation => {
  const found = conversations.get(session.id);
  // Rebuild when the persisted `serverId` has moved on, since the key may be a local placeholder that outlived creation.
  if (found && found.serverId() === session.serverId) return found;
  const create = async () => {
    const id = await mintId();
    // A failed step must not fail the create; the step's owner retries once the id is adopted.
    if (id?.trim()) await afterCreate(session.id, id).catch((e: unknown) => console.warn("[sessions] post-create step failed:", e));
    return id;
  };
  const onCreated = (key: string, id: string) => adoptServerId(key, id);
  const c = session.serverId
    ? new Conversation({
        key: session.id,
        id: session.serverId,
        config: agentHostConfig,
        create,
        onCreated,
      })
    : Conversation.pending(session.id, agentHostConfig, create, onCreated);
  conversations.set(session.id, c);
  return c;
};

/** The current conversation. */
export const currentConversation = (): Conversation | undefined => {
  const cur = state.sessions.find((s) => s.id === state.currentId);
  return cur ? conversationFor(cur) : undefined;
};

/** Record the server's id on the session whose key this is, leaving the stable key itself unchanged. */
const adoptServerId = (key: string, serverId: string): void => {
  const cur = state.sessions.find((s) => s.id === key);
  if (!cur) return;
  setState({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === key ? { ...s, serverCreated: true, serverId } : s,
    ),
  });
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** The conversation a `/chat/<id>` page is pinned to (chatRoute.ts); undefined in the main app. */
let pinnedId: string | undefined;

/** A reply in the open conversation is read as it lands, and opening one reads its last reply,
 *  so the sidebar never shows the selected row as unread. */
const markCurrentSeen = (s: State): State => {
  const i = s.sessions.findIndex((x) => x.id === s.currentId);
  const cur = s.sessions[i];
  if (!cur || cur.lastReplyAt === undefined || (cur.lastSeenAt ?? 0) >= cur.lastReplyAt) return s;
  const sessions = s.sessions.slice();
  sessions[i] = { ...cur, lastSeenAt: cur.lastReplyAt };
  return { ...s, sessions };
};

/** The sidebar dot for a row, or undefined for none. */
export type TurnDot = "question" | "active" | "unread" | "unread-idle" | "idle" | "failed";
export const turnDot = (s: Session): TurnDot | undefined => {
  if (s.status === "failed") return "failed";
  // The agent is blocked on the user, which outranks every turn state.
  if (s.awaitingInputAt !== undefined) return "question";
  // A suspended or ended sandbox cannot be mid-turn, whatever a stale row says.
  const live = s.status === undefined || s.status === "running";
  if (s.runStartedAt !== undefined && live) return "active";
  if (s.lastReplyAt !== undefined && s.lastReplyAt > (s.lastSeenAt ?? 0)) return live ? "unread" : "unread-idle";
  if (s.status === "running") return "idle";
  return undefined;
};

const setState = (next: State) => {
  // A pinned page never leaves its conversation: whatever would move the selection (a delete,
  // a new-thread action) is held on the pinned one while it is listed.
  if (pinnedId !== undefined && next.currentId !== pinnedId && next.sessions.some((s) => s.id === pinnedId)) {
    next = { ...next, currentId: pinnedId };
  }
  next = markCurrentSeen(next);
  state = next;
  // The pinned page shares localStorage with the main app, so it must not overwrite its list.
  if (pinnedId === undefined) persist(next);
  emit();
};

/** Queue a frame the rename lock is holding back: newest wins per conversation, and a full-list
 *  frame supersedes the queue — which is also what bounds it. Why: PR #783. */
const queueFrame = (frame: PendingFrame) => {
  const queued = state.pendingFrames ?? [];
  const ids =
    frame.kind === "remove" ? [frame.serverId] : frame.convs.map((c) => c.id);
  const supersedesAll = frame.kind === "merge" && (frame.opts?.fullList ?? true);
  const kept = supersedesAll
    ? []
    : queued.filter((q) =>
        (q.kind === "remove" ? [q.serverId] : q.convs.map((c) => c.id)).every(
          (id) => !ids.includes(id),
        ),
      );
  setState({ ...state, pendingFrames: [...kept, frame] });
};

/** The row an interaction is holding the list still for: an open rename, else a hovered action tile. */
const heldRowId = (s: State): string | undefined => s.editingId ?? s.hoverId;

/** Replay the frames that arrived while the rename lock held; called wherever that lock clears. */
const flushPendingFrames = () => {
  const queued = state.pendingFrames;
  if (!queued?.length) return;
  // Cleared first so the replay, which re-enters the store, cannot re-queue behind itself.
  setState({ ...state, pendingFrames: undefined });
  for (const frame of queued) {
    if (frame.kind === "remove") sessionStore.removeFromServer(frame.serverId);
    else sessionStore.mergeFromServer(frame.convs, frame.opts);
  }
};

export const sessionStore = {
  /** Pin this page to one conversation (the `/chat/<id>` subpage): start from a clean list rather
   *  than the main app's saved one, whose local keys could shadow the server id, never persist,
   *  and keep the selection on `id` once the server lists it. */
  pin(id: string) {
    pinnedId = id;
    state = { ...freshState(), scope: "all" };
    this.requestSelect(id);
  },

  /** Move this page's pin to another conversation, keeping the loaded list. */
  repin(id: string) {
    pinnedId = id;
    this.requestSelect(id);
  },

  /** The conversation this page is pinned to, if any. */
  pinned(): string | undefined {
    return pinnedId;
  },

  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,

  current: () => state.sessions.find((s) => s.id === state.currentId)!,

  /** Start a new conversation with a local id and select it synchronously; ensureCurrentCreated() obtains the server id on the first prompt. */
  newSession(): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    setState({
      ...state,
      sessions: [
        { id, title: DEFAULT_TITLE, createdAt: now, lastActivityAt: now, serverCreated: false },
        ...state.sessions,
      ],
      currentId: id,
    });
    return id;
  },

  /** Open a new conversation, reusing an untouched one if present. */
  startFresh(): string {
    // A draft whose first send is mid-create is not spare, though it still looks untouched.
    const spare = state.sessions.find((s) => isPristine(s) && !isServerBacked(s) && !isCreating(s));
    if (!spare) return this.newSession();
    if (state.currentId !== spare.id) setState({ ...state, currentId: spare.id });
    return spare.id;
  },

  /** Ensure the current conversation exists server-side and return its server id (null if creation failed), without changing the session's stable key. */
  async ensureCurrentCreated(): Promise<string | null> {
    return (await currentConversation()?.ensureCreated()) ?? null;
  },

  switchTo(id: string) {
    if (state.sessions.some((s) => s.id === id)) setState({ ...state, currentId: id });
  },

  /** Select a conversation by id now, or stash it as pendingSelect for mergeFromServer to select when it appears. */
  requestSelect(id: string) {
    if (!id || state.currentId === id) return;
    if (state.sessions.some((s) => s.id === id)) {
      setState({ ...state, currentId: id, pendingSelect: undefined });
    } else {
      setState({ ...state, pendingSelect: id });
    }
  },

  /** Merge conversations loaded from the agent-host into the list, deduping by server id, sorting and keeping the current selection. */
  mergeFromServer(
    convs: ServerConversation[],
    // `fullList` is membership: only a full-list read (the poll or the SSE snapshot) can say a
    // row is gone. `sourcesAuthoritative` is per-row content: whether this read's
    // `sources`/`links` replace what is held. A single-row upsert is the one case where they
    // differ — it owns its own row's links but says nothing about any other row. Why: PR #779.
    opts?: MergeOpts,
  ) {
    const fullList = opts?.fullList ?? true;
    const authoritative = opts?.sourcesAuthoritative ?? true;
    if (convs.length === 0) return;
    // While an inline rename input is open, the merge must not re-render the sidebar at all, since
    // reconciliation can detach the input. A pointer on a row's actions holds it the same way, so a
    // reorder cannot move a different conversation under the click.
    if (heldRowId(state) !== undefined) {
      // A hold only lasts while its row is still rendered, because nothing else could clear it
      // once the row is gone; each hold is checked on its own so one going stale keeps the other.
      const rendered = filteredSessions(state);
      const live = (id?: string) => (id !== undefined && rendered.some((s) => s.id === id) ? id : undefined);
      const editingId = live(state.editingId);
      const hoverId = live(state.hoverId);
      if (editingId !== state.editingId || hoverId !== state.hoverId) {
        setState({ ...state, editingId, hoverId });
      }
      if (heldRowId(state) !== undefined) {
        // Deferred, not dropped: the stream sends each change once. Why: PR #783.
        queueFrame({ kind: "merge", convs, opts });
        return;
      }
      flushPendingFrames();
    }
    const serverIds = new Set(convs.map((c) => c.id));
    // Index by the server id, which is what `convs` is keyed by.
    const byId = new Map<string, Session>();
    for (const s of state.sessions) byId.set(s.serverId ?? s.id, s);
    for (const c of convs) {
      const existing = byId.get(c.id);
      // A user-set server title wins outright, a non-default server title next, and the server's "New chat" placeholder never clobbers a local title.
      const userTitled = c.userTitled ?? existing?.userTitled ?? false;
      const serverTitle = c.title && c.title !== DEFAULT_TITLE ? c.title : undefined;
      const localTitle =
        existing && existing.title !== DEFAULT_TITLE ? existing.title : undefined;
      const title = userTitled && c.title
        ? c.title
        : serverTitle ?? localTitle ?? c.title ?? existing?.title ?? DEFAULT_TITLE;
      const merged: Session = {
        // The existing stable key is preserved, since a conversation created on its first send keys by a local id.
        id: existing?.id ?? c.id,
        title,
        userTitled,
        serverCreated: true,
        serverId: c.id,
        starred: starredKeys.has(c.id) || undefined,
        visibility: c.visibility ?? existing?.visibility,
        createdAt: c.createdAt ?? existing?.createdAt ?? Date.now(),
        lastActivityAt: c.lastActivityAt ?? existing?.lastActivityAt ?? Date.now(),
        // Only an unsent pick outranks the server, which also records the agent's switches.
        model: existing?.pendingModel ?? c.model,
        pendingModel: existing?.pendingModel,
        sources: authoritative ? (c.sources ?? existing?.sources) : existing?.sources,
        links: authoritative ? (c.links ?? existing?.links) : existing?.links,
        owner: c.owner ?? existing?.owner,
        status: c.status ?? existing?.status,
        parentId: c.parentId ?? existing?.parentId,
        kind: c.kind ?? existing?.kind,
        origin: c.origin ?? existing?.origin,
        // Every server row is a whole row, so an absent runStartedAt means the turn ended.
        runStartedAt: c.runStartedAt,
        lastReplyAt: c.lastReplyAt ?? existing?.lastReplyAt,
        awaitingInputAt: c.awaitingInputAt,
        // Only a snapshot baselines an unmarked row as read; a live upsert is a new reply.
        lastSeenAt: existing?.lastSeenAt ?? (fullList ? c.lastReplyAt ?? existing?.lastReplyAt : 0),
      };
      // Keep the existing reference when nothing changed so React.memo skips the row.
      byId.set(c.id, existing && sameSession(existing, merged) ? existing : merged);
    }

    // Reconcile against the server's list: keep what it lists, and prune rows it no longer does except the current selection.
    let sessions = [...byId.values()].filter((s) => {
      if (serverIds.has(serverKeyOf(s))) return true;
      // Absence is only evidence in a full-list read.
      if (!fullList) return true;
      if (s.parentId) return false; // an ended subagent
      if (s.id === state.currentId) return true;
      // Mid-create, the list read may predate the create; dropping the row would orphan the new conversation.
      if (isCreating(s)) return true;
      // A row the server never created can only shadow the real conversation it was meant to become.
      if (!isServerBacked(s)) return false;
      return !isPristine(s);
    });
    // Never end up with zero rows.
    if (sessions.length === 0) sessions = [...byId.values()];
    sessions.sort(byStarredThenRecent);

    // The selection is owned by switchTo/newSession, so the merge only repairs a vanished currentId and honors a pending deep-link.
    let pendingSelect = state.pendingSelect;
    let currentId = sessions.some((s) => s.id === state.currentId)
      ? state.currentId
      : (sessions[0]?.id ?? state.currentId);
    if (pendingSelect && sessions.some((s) => s.id === pendingSelect)) {
      currentId = pendingSelect;
      pendingSelect = undefined;
    }

    // No-op when nothing changed, compared via sameSession so no field's updates are silently discarded.
    const unchanged =
      pendingSelect === state.pendingSelect &&
      currentId === state.currentId &&
      sessions.length === state.sessions.length &&
      sessions.every((s, i) => s === state.sessions[i] || sameSession(s, state.sessions[i]));
    if (unchanged) return;

    setState({ ...state, sessions, currentId, pendingSelect });
  },

  /** Drop a conversation the server says is gone, keyed by SERVER id; a no-op for one we never had. */
  removeFromServer(serverId: string) {
    // An open rename input would be detached by the re-render, so the removal waits for the
    // lock to clear. It cannot simply be skipped: the stream sends a remove frame once, and
    // with no poll behind it a dropped one leaves a dead row in the sidebar. Why: PR #780.
    if (heldRowId(state) !== undefined) {
      queueFrame({ kind: "remove", serverId });
      return;
    }
    const gone = state.sessions.find((s) => serverKeyOf(s) === serverId);
    if (!gone) return;
    sessionStore.deleteSession(gone.id);
  },

  /** Delete a conversation. If it was current, select another (or start fresh). */
  deleteSession(id: string) {
    const remaining = state.sessions.filter((s) => s.id !== id);
    if (remaining.length === 0) {
      // Always keep at least one conversation.
      const now = Date.now();
      const fresh = { id: crypto.randomUUID(), title: DEFAULT_TITLE, createdAt: now, lastActivityAt: now };
      setState({ ...state, sessions: [fresh], currentId: fresh.id });
      return;
    }
    const currentId = state.currentId === id ? remaining[0].id : state.currentId;
    setState({ ...state, sessions: remaining, currentId });
  },

  /** Derive a title from the first user message if the title is still the default. */
  titleFromFirstMessage(id: string, text: string) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || s.title !== DEFAULT_TITLE) return;
    const title = text.slice(0, 60).trim();
    if (!title) return;
    this.setTitle(id, title);
  },

  /** Set the agent-assigned title, unless the user renamed the conversation. */
  setTitle(id: string, title: string) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || s.userTitled || s.title === title) return;
    setState({
      ...state,
      sessions: state.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
    });
  },

  /** Mark a conversation as being renamed inline, which pauses mergeFromServer. */
  setEditing(id: string) {
    if (state.editingId === id) return;
    // The action tiles unmount while editing, so no pointerleave would ever release a hover hold.
    setState({ ...state, editingId: id, hoverId: undefined });
  },

  /** Clear the rename lock, ignoring a stale clear for a row that is not the editing one. */
  clearEditing(id?: string) {
    if (state.editingId === undefined) return;
    if (id !== undefined && state.editingId !== id) return;
    setState({ ...state, editingId: undefined });
    if (state.hoverId === undefined) flushPendingFrames();
  },

  /** Hold the list still while the pointer is on a row's action tiles (star/rename/delete). */
  setHover(id: string) {
    if (state.hoverId === id) return;
    setState({ ...state, hoverId: id });
  },

  /** Release a hover hold, ignoring a stale release from a row that no longer holds it. */
  clearHover(id?: string) {
    if (state.hoverId === undefined) return;
    if (id !== undefined && state.hoverId !== id) return;
    setState({ ...state, hoverId: undefined });
    if (state.editingId === undefined) flushPendingFrames();
  },

  /** Optimistically set a user-chosen title and lock it against agent titles; the caller persists via renameConversation. */
  renameSession(id: string, title: string) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    setState({
      ...state,
      sessions: state.sessions.map((x) => (x.id === id ? { ...x, title, userTitled: true } : x)),
    });
  },

  /** Mirror the viewer's Starred folder onto the sessions and re-sort. */
  setStarredKeys(keys: ReadonlySet<string>) {
    starredKeys = keys;
    const sessions = state.sessions.map((s) => {
      const starred = keys.has(serverKeyOf(s)) || undefined;
      return s.starred === starred ? s : { ...s, starred };
    });
    sessions.sort(byStarredThenRecent);
    setState({ ...state, sessions });
  },

  /** Optimistically set a conversation's visibility (and its subagents', which follow it); the caller persists via setConversationVisibility. */
  setVisibility(id: string, visibility: "shared" | "private") {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || (s.visibility ?? "shared") === visibility) return;
    const key = s.serverId ?? s.id;
    const sessions = state.sessions.map((x) =>
      x.id === id || x.parentId === key ? { ...x, visibility } : x,
    );
    setState({ ...state, sessions });
  },

  /** Set a conversation's model, which the next prompt carries via the X-Agent-Model header. */
  setModel(id: string, model: string) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || s.model === model) return;
    setState({
      ...state,
      sessions: state.sessions.map((x) => (x.id === id ? { ...x, model, pendingModel: model } : x)),
    });
  },

  /** A prompt carrying `model` was accepted, so the pick is no longer pending. */
  modelSent(id: string, model: string) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || s.pendingModel !== model) return;
    setState({
      ...state,
      sessions: state.sessions.map((x) => (x.id === id ? { ...x, pendingModel: undefined } : x)),
    });
  },

  /** Record the caller's identity from /whoami. */
  setCurrentUser(user: { id: string; email?: string | null; anonymous?: boolean }) {
    const email = user.email ?? null;
    const anonymous = user.anonymous ?? false;
    if (state.currentUser === user.id && state.currentUserEmail === email && state.currentUserAnonymous === anonymous) return;
    setState({ ...state, currentUser: user.id, currentUserEmail: email, currentUserAnonymous: anonymous });
  },

  /** Flip the sidebar Mine/All filter. */
  setScope(scope: Scope) {
    if (state.scope === scope) return;
    setState({ ...state, scope });
  },

  /** Set the sidebar keyword-search query (matches title + link names). */
  setQuery(query: string) {
    if (state.query === query) return;
    setState({ ...state, query });
  },

  /** Toggle a provider filter chip on/off (multi-select). */
  toggleProvider(provider: LinkProvider) {
    const on = state.providerFilter.includes(provider);
    const providerFilter = on
      ? state.providerFilter.filter((p) => p !== provider)
      : [...state.providerFilter, provider];
    setState({ ...state, providerFilter });
  },

  /** Clear all provider filter chips. */
  clearProviders() {
    if (state.providerFilter.length === 0) return;
    setState({ ...state, providerFilter: [] });
  },

  /** Set the "Show:" label mode (title or a specific provider's link name). */
  setLabelMode(labelMode: LabelMode) {
    if (state.labelMode === labelMode) return;
    setState({ ...state, labelMode });
  },
};

/** The first linked resource of a session, or undefined when unlinked. */
export function primaryLink(s: Session): SessionLink | undefined {
  return s.links && s.links.length > 0 ? s.links[0] : undefined;
}

/** The session's first link for a given provider, or undefined if it has none. */
export function linkForProvider(s: Session, provider: LinkProvider): SessionLink | undefined {
  return (s.links ?? []).find((l) => l.source === provider);
}

/** A human name for a link: its title, else "<source> <type>", else the source. */
export function linkName(l: SessionLink): string {
  if (l.title) return l.title;
  const type = l.resourceType ? ` ${l.resourceType.replace(/_/g, " ")}` : "";
  return `${l.source}${type}`.trim();
}

/** The label shown for a session row under the given label mode, falling back to the title. */
export function sessionLabel(s: Session, mode: LabelMode): string {
  if (mode !== "title") {
    const l = linkForProvider(s, mode);
    if (l) return linkName(l);
  }
  return s.title;
}

/** Filter by the Mine/All scope, where Mine shows only the caller's own conversations once a non-anonymous identity is known and everything before that. */
export function visibleSessions(state: State): Session[] {
  const known = !!state.currentUser && !state.currentUserAnonymous;
  if (state.scope === "all" || !known) return state.sessions;
  return state.sessions.filter((s) => s.owner === state.currentUser);
}

/** Whether a session links to any selected provider (no chips selected passes everything). */
function matchesProviders(s: Session, providers: LinkProvider[]): boolean {
  if (providers.length === 0) return true;
  const srcs = new Set([...(s.sources ?? []), ...(s.links ?? []).map((l) => l.source)]);
  return providers.some((p) => srcs.has(p));
}

/** Whether the title or any linked resource's name or url contains the query, case-insensitively. */
function matchesQuery(s: Session, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (s.title.toLowerCase().includes(needle)) return true;
  return (s.links ?? []).some(
    (l) =>
      linkName(l).toLowerCase().includes(needle) ||
      (l.url ?? "").toLowerCase().includes(needle),
  );
}

/** The sidebar list after the scope, provider and keyword filters. */
export function filteredSessions(state: State): Session[] {
  return visibleSessions(state).filter(
    (s) => matchesProviders(s, state.providerFilter) && matchesQuery(s, state.query),
  );
}

/** A sidebar row with its nesting depth (0 = top-level, 1 = subagent) and, on a collapsed parent, the number of hidden subagents. */
export interface SidebarRow {
  session: Session;
  depth: number;
  childCount: number;
}

/** Order a flat session list as a hierarchy with each parent followed by its subagents, a parentless child as a top-level row, and, when `activeId` is given, only the active branch's subagents expanded. */
export function nestSubagents(sessions: Session[], activeId?: string): SidebarRow[] {
  // Index by server id, because `parentId` is server-owned.
  const byServerId = new Map<string, Session>();
  for (const s of sessions) byServerId.set(serverKeyOf(s), s);
  const childrenOf = new Map<string, Session[]>();
  const tops: Session[] = [];
  for (const s of sessions) {
    // A subagent whose parent is in the list nests under it.
    const parent = s.parentId ? byServerId.get(s.parentId) : undefined;
    if (parent && parent !== s) {
      (childrenOf.get(parent.id) ?? childrenOf.set(parent.id, []).get(parent.id)!).push(s);
    } else {
      tops.push(s);
    }
  }
  const rows: SidebarRow[] = [];
  for (const top of tops) {
    const children = childrenOf.get(top.id) ?? [];
    // Expand iff there is no activeId or the active conversation is this parent or one of its children.
    const onActiveBranch =
      activeId === undefined || activeId === top.id || children.some((ch) => ch.id === activeId);
    const expand = onActiveBranch || children.length === 0;
    rows.push({ session: top, depth: 0, childCount: expand ? 0 : children.length });
    if (expand) for (const child of children) rows.push({ session: child, depth: 1, childCount: 0 });
  }
  return rows;
}

export function useSessions(): State {
  // The in-memory snapshot doubles as getServerSnapshot so SSR renders work.
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get, sessionStore.get);
}

/** Whether a conversation title is being renamed inline; re-renders only when that flips. */
export function useRenaming(): boolean {
  const get = () => sessionStore.get().editingId !== undefined;
  return useSyncExternalStore(sessionStore.subscribe, get, get);
}

/** The signed-in caller from /whoami, for the header user badge. */
export function useCurrentUser(): { id: string; email: string | null; anonymous: boolean } {
  const s = useSessions();
  return { id: s.currentUser, email: s.currentUserEmail, anonymous: s.currentUserAnonymous };
}
