/**
 * Thread density on the /chat/<id> page: "comfortable", or "compact", which folds tool
 * calls and reasoning to one line and shrinks text and padding for a narrow side pane.
 *
 * The framing page picks the default with `?density=compact`. The header toggle overrides
 * it, remembered per default, so a user who prefers comfortable in compact hosts keeps that
 * without it leaking into hosts that never asked for compact.
 */

import { createContext, useSyncExternalStore } from "react";

export type Density = "comfortable" | "compact";

function parse(v: string | null | undefined): Density | undefined {
  return v === "compact" || v === "comfortable" ? v : undefined;
}

/** The density a `?density=` query asks for, comfortable when it asks for none. */
export function densityFromQuery(search: string): Density {
  return parse(new URLSearchParams(search).get("density")) ?? "comfortable";
}

/** Where the user's choice is kept, one slot per host default. */
export function densityStorageKey(hostDefault: Density): string {
  return `scooter.chat.density.${hostDefault}`;
}

/** The density to start with: the user's choice for this host default, else the default. */
export function initialDensity(search: string, storage: Pick<Storage, "getItem"> | undefined): Density {
  const hostDefault = densityFromQuery(search);
  try {
    return parse(storage?.getItem(densityStorageKey(hostDefault))) ?? hostDefault;
  } catch {
    // Storage can be off in a third-party frame.
    return hostDefault;
  }
}

function browserStorage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

let current: Density | undefined;
const listeners = new Set<() => void>();

function get(): Density {
  current ??= initialDensity(location.search, browserStorage());
  return current;
}

export const densityStore = {
  get,
  set(d: Density) {
    if (d === get()) return;
    current = d;
    try {
      browserStorage()?.setItem(densityStorageKey(densityFromQuery(location.search)), d);
    } catch {
      // Not remembered, but still applied to this page.
    }
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useDensity(): Density {
  return useSyncExternalStore(densityStore.subscribe, densityStore.get, densityStore.get);
}

/** Whether the thread below renders compact; only the /chat/<id> page provides true. */
export const CompactContext = createContext(false);
