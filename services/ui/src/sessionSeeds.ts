/** Whether new sessions may start from context, per /whoami. */

import { useSyncExternalStore } from "react";

import type { SessionSeedMode } from "./client.js";

let summary = false;
const listeners = new Set<() => void>();

/** Adopt the modes /whoami advertises. */
export function setSessionSeeds(modes: readonly SessionSeedMode[] | undefined): void {
  const next = !!modes?.includes("summary");
  if (next === summary) return;
  summary = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const get = () => summary;

/** Whether "New session from context" is available. */
export function useSummarySeeds(): boolean {
  return useSyncExternalStore(subscribe, get, get);
}
