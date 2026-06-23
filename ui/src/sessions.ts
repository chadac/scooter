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
