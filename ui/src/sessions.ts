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
  /** Compact linked-resource summary (source/type/title/url). Server-sourced; drives
   *  the "show link name instead of title" toggle, keyword search over link names, and
   *  the provider filter. [] / undefined when none. */
  links?: SessionLink[];
  /** Creating user (server-sourced). undefined = unowned/public. Drives the
   *  Mine/All view filter. */
  owner?: string;
}

/** One linked external resource, as summarized in the conversation list. */
export interface SessionLink {
  source: string; // "github" | "gitlab" | "slack" | "jira" | …
  resourceType: string; // "pull_request" | "merge_request" | "issue" | "thread" | …
  url?: string;
  title?: string;
}

const DEFAULT_TITLE = "New chat";
const STORAGE_KEY = "kubenix-agent.sessions.v1";

/** Sidebar view filter: the caller's own conversations or all of them. */
export type Scope = "mine" | "all";

/** The known link providers — offered as icon filter chips AND as the "Show:"
 *  label-mode options. */
export const LINK_PROVIDERS = ["github", "gitlab", "slack", "jira"] as const;
export type LinkProvider = (typeof LINK_PROVIDERS)[number];

/** What a sidebar row displays: the conversation title, or the linked resource's
 *  name for a specific provider (falling back to the title when the row has no link
 *  of that provider). The "Show:" dropdown selects this. */
export type LabelMode = "title" | LinkProvider;

type State = {
  sessions: Session[];
  currentId: string;
  /** The caller's id (from /whoami), for the Mine filter. "" until loaded. */
  currentUser: string;
  /** The caller's email (from /whoami), for display. null when unknown/anonymous. */
  currentUserEmail: string | null;
  /** True when the caller is anonymous (no ingress identity — auth off / dev). */
  currentUserAnonymous: boolean;
  /** Sidebar Mine/All toggle (default Mine). */
  scope: Scope;
  /** Keyword search over the title + linked-resource names (empty = no search). */
  query: string;
  /** Selected provider filter chips; empty = no provider filter (show all). A
   *  session matches if it links to ANY selected provider. */
  providerFilter: LinkProvider[];
  /** What rows display — the title, or a provider's linked-resource name. Persisted. */
  labelMode: LabelMode;
  /** A deep-link target (from ?thread=<id>) to select AS SOON AS it's known — the
   *  conversation may not be in the list yet (it arrives via the poll/stream for a
   *  webhook-created thread the user has never opened). Cleared once selected. */
  pendingSelect?: string;
};

/** A brand-new, untouched conversation (default title, no messages yet). */
const isPristine = (s: Session) => s.title === DEFAULT_TITLE;

const freshState = (): State => {
  const id = crypto.randomUUID();
  return {
    sessions: [{ id, title: DEFAULT_TITLE, createdAt: Date.now() }],
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
    return {
      sessions, currentId, currentUser: "", currentUserEmail: null,
      currentUserAnonymous: true, scope: parsed.scope === "all" ? "all" : "mine",
      // Search + provider filter are transient (a stale filter hiding every chat
      // after a refresh would baffle); the label mode persists like scope.
      query: "", providerFilter: [],
      labelMode: (LINK_PROVIDERS as readonly string[]).includes(parsed.labelMode)
        ? (parsed.labelMode as LabelMode)
        : "title",
    };
  } catch (e) {
    // Finding #26: corrupt persisted state -> start fresh (recoverable), but log
    // it so a user silently losing their session list is diagnosable rather than
    // invisible.
    console.warn("[sessions] persisted state unreadable; starting fresh:", e);
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
   * Select a conversation by id, even one not yet in the list. For the ?thread=
   * deep-link: a webhook-created conversation the user has never opened isn't in
   * localStorage — it arrives via the /conversations poll/stream. If it's already
   * known, select it now; otherwise stash it as pendingSelect and mergeFromServer
   * selects it the moment it appears. A no-op if already current.
   */
  requestSelect(id: string) {
    if (!id || state.currentId === id) return;
    if (state.sessions.some((s) => s.id === id)) {
      setState({ ...state, currentId: id, pendingSelect: undefined });
    } else {
      setState({ ...state, pendingSelect: id });
    }
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
    convs: Array<{ id: string; title?: string; createdAt?: number; model?: string; sources?: string[]; links?: SessionLink[]; owner?: string }>,
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
        links: c.links ?? existing?.links,
        // Owner is server-owned (stamped at creation); take the server's value.
        owner: c.owner ?? existing?.owner,
      });
    }

    // Drop local pristine placeholders that the server doesn't know about: when
    // the server already has real conversations, an empty "New chat" the user
    // never touched shouldn't linger as a phantom extra row. (We keep local
    // sessions that have a non-default title or that exist on the server.)
    //
    // EXCEPTION: never drop the CURRENTLY-SELECTED pristine session. The user
    // just clicked "New chat" and is about to type — the server won't know about
    // it until the first message POSTs /agui, so a background poll would otherwise
    // yank the conversation out from under them (and jump the selection to another
    // row) within one poll interval. The selected new chat is live intent, not a
    // stale phantom; keep it until it either gains a title or the user leaves it.
    let sessions = [...byId.values()].filter(
      (s) => serverIds.has(s.id) || !isPristine(s) || s.id === state.currentId,
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
    //
    // THE ONE EXCEPTION: a pending deep-link (?thread=<id> via requestSelect).
    // That's an explicit user intent waiting for the conversation to arrive, not a
    // background reassign — honor it the moment the target shows up, then clear it.
    let pendingSelect = state.pendingSelect;
    let currentId = sessions.some((s) => s.id === state.currentId)
      ? state.currentId
      : (sessions[0]?.id ?? state.currentId);
    if (pendingSelect && sessions.some((s) => s.id === pendingSelect)) {
      currentId = pendingSelect;
      pendingSelect = undefined;
    }

    // No-op if nothing actually changed (same ids+titles+order+selection). The
    // periodic merge poll calls this every few seconds; without this guard every
    // poll would setState -> re-render -> churn the runtime even when idle.
    const sig = (ss: Session[], cur: string) =>
      cur +
      "|" +
      ss
        .map(
          (s) =>
            `${s.id}:${s.title}:${(s.sources ?? []).join(",")}:${(s.links ?? [])
              .map((l) => l.title ?? l.url ?? "")
              .join(",")}`,
        )
        .join("|");
    // Include pendingSelect in the change check: if only the pending target was
    // cleared (selection already applied), the currentId sig already differs.
    if (
      pendingSelect === state.pendingSelect &&
      sig(sessions, currentId) === sig(state.sessions, state.currentId)
    )
      return;

    setState({ ...state, sessions, currentId, pendingSelect });
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

  /** Record the caller's identity (from /whoami): the id drives the Mine filter,
   *  the email + anonymous flag drive the header user badge. */
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

/** The first linked resource of a session (any provider). undefined when unlinked. */
export function primaryLink(s: Session): SessionLink | undefined {
  return s.links && s.links.length > 0 ? s.links[0] : undefined;
}

/** The session's first link for a given provider, or undefined if it has none. */
export function linkForProvider(s: Session, provider: LinkProvider): SessionLink | undefined {
  return (s.links ?? []).find((l) => l.source === provider);
}

/** A human name for a link: its title, else "<source> <type>" (e.g. "github
 *  pull_request"), else the source. */
export function linkName(l: SessionLink): string {
  if (l.title) return l.title;
  const type = l.resourceType ? ` ${l.resourceType.replace(/_/g, " ")}` : "";
  return `${l.source}${type}`.trim();
}

/** The label shown for a session row, honoring the "Show:" mode: "title" always
 *  shows the conversation title; a provider mode shows THAT provider's linked-resource
 *  name for rows that have such a link, falling back to the title otherwise. */
export function sessionLabel(s: Session, mode: LabelMode): string {
  if (mode !== "title") {
    const l = linkForProvider(s, mode);
    if (l) return linkName(l);
  }
  return s.title;
}

/** Filter a conversation list by the current Mine/All scope. "Mine" shows the
 *  caller's own + unowned/public conversations; "All" shows everything. With no
 *  known user yet (anonymous / pre-whoami), Mine shows everything (dev-friendly). */
export function visibleSessions(state: State): Session[] {
  if (state.scope === "all" || !state.currentUser) return state.sessions;
  return state.sessions.filter((s) => s.owner == null || s.owner === state.currentUser);
}

/** Does a session pass the selected provider filter? No chips selected -> yes. A
 *  session passes if it links to ANY selected provider. Providers are derived from
 *  the links (falling back to the server's `sources` set) so it works even before
 *  `sources` is populated. */
function matchesProviders(s: Session, providers: LinkProvider[]): boolean {
  if (providers.length === 0) return true;
  const srcs = new Set([...(s.sources ?? []), ...(s.links ?? []).map((l) => l.source)]);
  return providers.some((p) => srcs.has(p));
}

/** Does a session match the keyword query? Matches the title AND any linked
 *  resource's name/url (so searching a PR number or repo finds the chat). Empty
 *  query -> yes. Case-insensitive. */
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

/** The sidebar list after ALL filters: Mine/All scope, provider chips, and the
 *  keyword search. This is what the sidebar renders. */
export function filteredSessions(state: State): Session[] {
  return visibleSessions(state).filter(
    (s) => matchesProviders(s, state.providerFilter) && matchesQuery(s, state.query),
  );
}

export function useSessions(): State {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
}

/** The signed-in caller (from /whoami), for the header user badge. `id` is the
 *  ingress identity; `anonymous` is true when auth is off / no identity header. */
export function useCurrentUser(): { id: string; email: string | null; anonymous: boolean } {
  const s = useSessions();
  return { id: s.currentUser, email: s.currentUserEmail, anonymous: s.currentUserAnonymous };
}
