/**
 * Conversation (session) store — the source of truth for the left sidebar.
 *
 * Holds the list of conversations with titles and the current selection. Titles
 * are derived from the first user message by default, but an agent can override
 * a title (setTitle) — e.g. from an AG-UI custom/state event — so "the agent
 * assigns titles" is supported without depending on a specific agent yet.
 *
 * A tiny zustand-free store (useSyncExternalStore) to avoid extra wiring.
 */

import { useSyncExternalStore } from "react";

export interface Session {
  id: string; // AG-UI threadId
  title: string;
  createdAt: number;
  /** Per-conversation model (undefined = host default). Sent on the next prompt
   *  via the X-Agent-Model header; a change mid-conversation switches the model. */
  model?: string;
  /** Distinct linked-resource providers ("github"|"slack"|…) for the sidebar
   *  icons. Server-sourced (GET /conversations); [] / undefined when none. */
  sources?: string[];
  /** Creating user (server-sourced). undefined = unowned/public. Drives the
   *  Mine/All view filter. */
  owner?: string;
}

const DEFAULT_TITLE = "New chat";
const STORAGE_KEY = "kubenix-agent.sessions.v1";

/** Sidebar view filter: the caller's own conversations or all of them. */
export type Scope = "mine" | "all";

type State = {
  sessions: Session[];
  currentId: string;
  /** The caller's id (from /whoami), for the Mine filter. "" until loaded. */
  currentUser: string;
  /** Sidebar Mine/All toggle (default Mine). */
  scope: Scope;
};

/** A brand-new, untouched conversation (default title, no messages yet). */
const isPristine = (s: Session) => s.title === DEFAULT_TITLE;

const freshState = (): State => {
  const id = crypto.randomUUID();
  return {
    sessions: [{ id, title: DEFAULT_TITLE, createdAt: Date.now() }],
    currentId: id,
    currentUser: "",
    scope: "mine",
  };
};

/** Load persisted sessions from user data (localStorage), so the sidebar
 *  survives a refresh even before the server responds. Falls back to a single
 *  fresh conversation. The server's conversations are merged in on top (see
 *  mergeFromServer) — localStorage is the optimistic cache, the server is truth. */
const loadState = (): State => {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as State;
    if (!parsed?.sessions?.length || !parsed.currentId) return freshState();
    // Drop anything malformed; keep only well-formed sessions.
    const sessions = parsed.sessions.filter((s) => s && typeof s.id === "string");
    if (!sessions.length) return freshState();
    const currentId = sessions.some((s) => s.id === parsed.currentId)
      ? parsed.currentId
      : sessions[0].id;
    // currentUser is NOT persisted (it's re-fetched via /whoami on load); scope
    // persists so the toggle choice survives a refresh.
    return { sessions, currentId, currentUser: "", scope: parsed.scope === "all" ? "all" : "mine" };
  } catch {
    return freshState();
  }
};

let state: State = loadState();

const persist = (s: State) => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* user data unavailable (private mode / SSR) — non-fatal */
  }
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const setState = (next: State) => {
  state = next;
  persist(next);
  emit();
};

export const sessionStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,

  current: () => state.sessions.find((s) => s.id === state.currentId)!,

  newSession(): string {
    const id = crypto.randomUUID();
    setState({
      ...state,
      sessions: [{ id, title: DEFAULT_TITLE, createdAt: Date.now() }, ...state.sessions],
      currentId: id,
    });
    return id;
  },

  switchTo(id: string) {
    if (state.sessions.some((s) => s.id === id)) setState({ ...state, currentId: id });
  },

  /**
   * Merge conversations loaded from the agent-host into the list. Called on
   * startup so the sidebar survives a refresh and every conversation is listed
   * (not just ones created in this tab). Dedups by id, sorts newest-first, and
   * preserves the current selection. If the only local session is the untouched
   * initial "New chat" and the server has real conversations, select the newest
   * server one so a refresh lands on a real conversation.
   */
  mergeFromServer(
    convs: Array<{ id: string; title?: string; createdAt?: number; model?: string; sources?: string[]; owner?: string }>,
  ) {
    if (convs.length === 0) return;
    const serverIds = new Set(convs.map((c) => c.id));
    const byId = new Map<string, Session>();
    for (const s of state.sessions) byId.set(s.id, s);
    for (const c of convs) {
      const existing = byId.get(c.id);
      // Title precedence: a real server title wins; but a local non-default
      // title (e.g. derived from the first message) must NOT be clobbered by the
      // server's "New chat" placeholder — the server often hasn't learned the
      // title yet. So only take the server title when it's non-default.
      const serverTitle = c.title && c.title !== DEFAULT_TITLE ? c.title : undefined;
      const localTitle =
        existing && existing.title !== DEFAULT_TITLE ? existing.title : undefined;
      byId.set(c.id, {
        id: c.id,
        title: serverTitle ?? localTitle ?? c.title ?? existing?.title ?? DEFAULT_TITLE,
        createdAt: c.createdAt ?? existing?.createdAt ?? Date.now(),
        // A locally-chosen model (not yet persisted server-side on first prompt)
        // wins; otherwise take the server's persisted model.
        model: existing?.model ?? c.model,
        // Link sources are server-owned (the webhooks push links); always take
        // the server's value.
        sources: c.sources ?? existing?.sources,
        // Owner is server-owned (stamped at creation); take the server's value.
        owner: c.owner ?? existing?.owner,
      });
    }

    // Drop local pristine placeholders that the server doesn't know about: when
    // the server already has real conversations, an empty "New chat" the user
    // never touched shouldn't linger as a phantom extra row. (We keep local
    // sessions that have a non-default title or that exist on the server.)
    let sessions = [...byId.values()].filter(
      (s) => serverIds.has(s.id) || !isPristine(s),
    );
    // Never end up with zero rows (e.g. server has convs but all local were
    // pristine and got dropped — the server ones remain, which is fine).
    if (sessions.length === 0) sessions = [...byId.values()];
    sessions.sort((a, b) => b.createdAt - a.createdAt);

    // SELECTION-NEUTRAL: never change currentId here. The merge runs on a
    // background poll, so reassigning the selection would fight an in-flight
    // user switchTo()/newSession() (a read-modify-write race that dropped the
    // just-selected thread's view). Selection is owned by switchTo/newSession.
    // Only keep currentId valid if it vanished entirely from the list.
    const currentId = sessions.some((s) => s.id === state.currentId)
      ? state.currentId
      : (sessions[0]?.id ?? state.currentId);

    // No-op if nothing actually changed (same ids+titles+order+selection). The
    // periodic merge poll calls this every few seconds; without this guard every
    // poll would setState -> re-render -> churn the runtime even when idle.
    const sig = (ss: Session[], cur: string) =>
      cur + "|" + ss.map((s) => `${s.id}:${s.title}:${(s.sources ?? []).join(",")}`).join("|");
    if (sig(sessions, currentId) === sig(state.sessions, state.currentId)) return;

    setState({ ...state, sessions, currentId });
  },

  /** Delete a conversation. If it was current, select another (or start fresh). */
  deleteSession(id: string) {
    const remaining = state.sessions.filter((s) => s.id !== id);
    if (remaining.length === 0) {
      // Always keep at least one conversation.
      const fresh = { id: crypto.randomUUID(), title: DEFAULT_TITLE, createdAt: Date.now() };
      setState({ ...state, sessions: [fresh], currentId: fresh.id });
      return;
    }
    const currentId = state.currentId === id ? remaining[0].id : state.currentId;
    setState({ ...state, sessions: remaining, currentId });
  },

  /** Derive a title from the first user message if still default. No-op (no
   *  re-render) if the title is already set — avoids render loops. */
  titleFromFirstMessage(id: string, text: string) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || s.title !== DEFAULT_TITLE) return;
    const title = text.slice(0, 60).trim();
    if (!title) return;
    this.setTitle(id, title);
  },

  /** Agent-assigned title (overrides the derived one). No-op if unchanged. */
  setTitle(id: string, title: string) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || s.title === title) return;
    setState({
      ...state,
      sessions: state.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
    });
  },

  /** Set a conversation's model (the picker). No-op if unchanged. The next
   *  prompt carries it via the X-Agent-Model header (see RuntimeProvider). */
  setModel(id: string, model: string) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || s.model === model) return;
    setState({
      ...state,
      sessions: state.sessions.map((x) => (x.id === id ? { ...x, model } : x)),
    });
  },

  /** Record the caller's id (from /whoami), for the Mine view filter. */
  setCurrentUser(id: string) {
    if (state.currentUser === id) return;
    setState({ ...state, currentUser: id });
  },

  /** Flip the sidebar Mine/All filter. */
  setScope(scope: Scope) {
    if (state.scope === scope) return;
    setState({ ...state, scope });
  },
};

/** Filter a conversation list by the current Mine/All scope. "Mine" shows the
 *  caller's own + unowned/public conversations; "All" shows everything. With no
 *  known user yet (anonymous / pre-whoami), Mine shows everything (dev-friendly). */
export function visibleSessions(state: State): Session[] {
  if (state.scope === "all" || !state.currentUser) return state.sessions;
  return state.sessions.filter((s) => s.owner == null || s.owner === state.currentUser);
}

export function useSessions(): State {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
}
