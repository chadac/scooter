/**
 * Top-level view switch — chat (default) vs. the settings page. A tiny
 * useSyncExternalStore store (same pattern as sessions.ts) so the header's
 * settings toggle and App can flip the main pane without pulling in a router.
 */

import { useSyncExternalStore } from "react";

export type View = "chat" | "settings";

let view: View = "chat";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const viewStore = {
  set(v: View) {
    if (v === view) return;
    view = v;
    emit();
  },
  get(): View {
    return view;
  },
};

export function useView(): View {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => view,
    () => view,
  );
}
