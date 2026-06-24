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
}

const DEFAULT_TITLE = "New chat";

type State = { sessions: Session[]; currentId: string };

let state: State = (() => {
  const id = crypto.randomUUID();
  return { sessions: [{ id, title: DEFAULT_TITLE, createdAt: Date.now() }], currentId: id };
})();

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const setState = (next: State) => {
  state = next;
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
    convs: Array<{ id: string; title?: string; createdAt?: number }>,
  ) {
    if (convs.length === 0) return;
    const byId = new Map<string, Session>();
    for (const s of state.sessions) byId.set(s.id, s);
    for (const c of convs) {
      const existing = byId.get(c.id);
      byId.set(c.id, {
        id: c.id,
        title: c.title || existing?.title || DEFAULT_TITLE,
        createdAt: c.createdAt ?? existing?.createdAt ?? Date.now(),
      });
    }
    const sessions = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);

    // Was the current session the pristine initial one (random id, default
    // title, not on the server)? If so, jump to the newest real conversation.
    const cur = state.sessions.find((s) => s.id === state.currentId);
    const curIsPristineInitial =
      !!cur &&
      cur.title === DEFAULT_TITLE &&
      !convs.some((c) => c.id === state.currentId) &&
      state.sessions.length === 1;
    const currentId = curIsPristineInitial ? sessions[0].id : state.currentId;

    setState({ sessions, currentId });
  },

  /** Delete a conversation. If it was current, select another (or start fresh). */
  deleteSession(id: string) {
    const remaining = state.sessions.filter((s) => s.id !== id);
    if (remaining.length === 0) {
      // Always keep at least one conversation.
      const fresh = { id: crypto.randomUUID(), title: DEFAULT_TITLE, createdAt: Date.now() };
      setState({ sessions: [fresh], currentId: fresh.id });
      return;
    }
    const currentId = state.currentId === id ? remaining[0].id : state.currentId;
    setState({ sessions: remaining, currentId });
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
};

export function useSessions(): State {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
}
