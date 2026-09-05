/**
 * Mobile navigation state — which off-canvas drawer is open on a narrow viewport.
 *
 * The desktop shell is a three-column row (sessions | thread | right panel). Below
 * the `md` breakpoint the two fixed-width side columns would leave the thread no
 * room, so each collapses into an overlay drawer toggled from the header; the thread
 * + composer take the full width. Desktop (md+) ignores all of this — the CSS `md:`
 * variants pin both panels back in-flow regardless of the drawer state here.
 *
 * Same dependency-free useSyncExternalStore store as view.ts (no router/context).
 */
import { useSyncExternalStore } from "react";

/** Which drawer is open. Only one at a time; "none" is the resting state. */
export type Drawer = "none" | "sessions" | "panel";

let drawer: Drawer = "none";
let snapshot: Drawer = drawer; // stable reference for useSyncExternalStore
const listeners = new Set<() => void>();
const emit = () => {
  snapshot = drawer;
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const mobileNav = {
  /** Open a specific drawer (replaces any other that was open). */
  open(d: Exclude<Drawer, "none">) {
    if (drawer !== d) {
      drawer = d;
      emit();
    }
  },
  /** Close whatever drawer is open (no-op if already closed). */
  close() {
    if (drawer !== "none") {
      drawer = "none";
      emit();
    }
  },
  get(): Drawer {
    return drawer;
  },
  subscribe,
};

/** Reactively read which drawer is open. */
export function useDrawer(): Drawer {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

// Tailwind's `md` breakpoint is 768px; "mobile" is anything below it. Keeping the JS
// query one hair under 768 (767.98) matches the CSS `md:` cutover exactly, so the
// drawer behavior and the panel visibility never disagree at the boundary.
const MOBILE_QUERY = "(max-width: 767.98px)";

/** True on viewports below the `md` breakpoint. Re-renders on viewport change. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = globalThis.matchMedia?.(MOBILE_QUERY);
      if (!mq) return () => {};
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => globalThis.matchMedia?.(MOBILE_QUERY).matches ?? false,
    () => false, // no matchMedia (SSR/tests): assume desktop
  );
}
