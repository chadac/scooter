/**
 * Theme (light / dark / system) — a tiny useSyncExternalStore store, same pattern
 * as view.ts / sessions.ts (the app deliberately has no router/state library).
 *
 * Three modes:
 *   "light" | "dark"  — an explicit choice, persisted to localStorage.
 *   "system"          — follow the OS/browser (prefers-color-scheme), live: an OS
 *                       switch flips the app with no reload. This is the DEFAULT
 *                       when nothing is stored.
 *
 * The `dark` class on <html> is the single switch every token reads (globals.css
 * `.dark` block). This module is the ONLY runtime writer of that class; a tiny
 * inline script in index.html applies the same resolution BEFORE first paint so
 * there is no light->dark flash on load (keep the two in sync). PR #465.
 */
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "scooter-theme";

const listeners = new Set<() => void>();

function readStored(): ThemeMode {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage can throw (private mode / disabled) — fall back to system.
  }
  return "system";
}

let mode: ThemeMode = readStored();

const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

/** Does the current mode resolve to a dark appearance right now? */
function resolvesDark(m: ThemeMode = mode): boolean {
  if (m === "dark") return true;
  if (m === "light") return false;
  return media?.matches ?? false;
}

/** Converge <html>.dark to the resolved appearance. Idempotent. */
function apply() {
  globalThis.document?.documentElement.classList.toggle("dark", resolvesDark());
}

function emit() {
  apply();
  for (const cb of listeners) cb();
}

// "system" mode must react LIVE to an OS appearance change (no reload). The listener
// only repaints while we're actually in system mode.
media?.addEventListener?.("change", () => {
  if (mode === "system") emit();
});

// Converge once at import — the inline <head> script already set the class pre-paint,
// this keeps the store's view of the world authoritative for later toggles.
apply();

export const themeStore = {
  get(): ThemeMode {
    return mode;
  },
  set(next: ThemeMode) {
    if (next === mode) return;
    mode = next;
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; the in-memory mode still drives the UI.
    }
    emit();
  },
  /** Whether the app currently renders dark (resolving "system"). */
  isDark(): boolean {
    return resolvesDark();
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The current mode ("light" | "dark" | "system"). */
export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribe, () => mode, () => mode);
}
