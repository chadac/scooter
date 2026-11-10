/**
 * Which pending request is open in the central detail view, and each request's draft
 * input. Both live outside React so the brief card in the Approvals tab and the detail
 * view are two renderings of one request: a pick made in either shows in the other.
 */

import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";

type Listener = () => void;

let focusedId: string | null = null;
const drafts = new Map<string, unknown>();
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((l) => l());
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const approvalFocus = {
  open(id: string): void {
    if (focusedId === id) return;
    focusedId = id;
    notify();
  },
  close(): void {
    if (focusedId === null) return;
    focusedId = null;
    notify();
  },
  get: (): string | null => focusedId,
  subscribe,
};

/** The id of the request open in the detail view, or null. */
export function useFocusedApproval(): string | null {
  return useSyncExternalStore(subscribe, approvalFocus.get, approvalFocus.get);
}

/** The draft input stored for one request, or `initial` when there is none. */
export function draftOf<T>(id: string, initial: T): T {
  return drafts.has(id) ? (drafts.get(id) as T) : initial;
}

export function setDraft(id: string, value: unknown): void {
  drafts.set(id, value);
  notify();
}

/** Drop drafts and focus for requests no longer pending, so a re-raised id starts clean. */
export function pruneApprovals(pending: readonly string[]): void {
  const live = new Set(pending);
  let changed = false;
  for (const id of drafts.keys()) {
    if (!live.has(id)) {
      drafts.delete(id);
      changed = true;
    }
  }
  if (focusedId !== null && !live.has(focusedId)) {
    focusedId = null;
    changed = true;
  }
  if (changed) notify();
}

/** The request id a renderer's draft is keyed by, provided per card by the core. */
export const RequestIdContext = createContext<string | null>(null);

/** useState for a renderer, shared between a request's brief and detail views. */
export function useRequestDraft<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const id = useContext(RequestIdContext);
  // A stable seed: a fresh literal per render would loop useSyncExternalStore.
  const seed = useRef(initial).current;
  const read = () => (id === null ? seed : draftOf(id, seed));
  const value = useSyncExternalStore(subscribe, read, read);
  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      if (id === null) return;
      const prev = draftOf(id, seed);
      setDraft(id, typeof next === "function" ? (next as (p: T) => T)(prev) : next);
    },
    [id, seed],
  );
  return [value, update];
}

/** Whether an approval is open or holds unsent input. */
export function approvalDraftsHeld(): boolean {
  return focusedId !== null || drafts.size > 0;
}
