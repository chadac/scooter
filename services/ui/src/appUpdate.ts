/** Noticing a newer deployed UI build, and reloading onto it safely. */

import { useSyncExternalStore } from "react";

import { approvalDraftsHeld } from "./approvalFocus.js";
import { pollWhileVisible, documentVisibility, type VisibilityHost } from "./visiblePoll.js";

export const HIDDEN_RELOAD_MS = 10 * 60_000;

export interface UpdateWatch {
  /** Compare the deployed build now. */
  check(): Promise<void>;
  stop(): void;
}

/** Poll for a newer build; reload a long-hidden tab onto it. */
export function watchForUpdates(deps: {
  current: string;
  fetchImpl?: typeof fetch;
  visibility?: VisibilityHost;
  reload?: () => void;
  wouldLoseWork?: () => boolean;
}): UpdateWatch {
  const visibility = deps.visibility ?? documentVisibility;
  const reload = deps.reload ?? (() => globalThis.location.reload());
  const wouldLoseWork = deps.wouldLoseWork ?? reloadWouldLoseWork;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
  };
  // Restarts on each hide: the whole stretch must be hidden.
  const arm = () => {
    if (!state.available || visibility.visible() || hiddenTimer !== undefined) return;
    hiddenTimer = setTimeout(() => {
      hiddenTimer = undefined;
      if (!visibility.visible() && !wouldLoseWork()) reload();
    }, HIDDEN_RELOAD_MS);
  };

  const check = async () => {
    const deployed = await fetchDeployedBuild(deps.fetchImpl);
    if (deployed === null || deployed === deps.current) return;
    updateStore.markAvailable(deployed);
    arm();
  };

  const stopPoll = pollWhileVisible(() => void check(), 5 * 60_000, visibility);
  const stopVisibility = visibility.onChange(() => (visibility.visible() ? disarm() : arm()));
  return {
    check,
    stop() {
      stopPoll();
      stopVisibility();
      disarm();
    },
  };
}

/** Full-load conversation `serverId` onto a newer build; false means switch in-app. */
export function reloadInto(
  serverId: string | undefined,
  deps: { assign?: (url: string) => void; wouldLoseWork?: () => boolean } = {},
): boolean {
  if (!state.available || !serverId || (deps.wouldLoseWork ?? reloadWouldLoseWork)()) return false;
  const url = new URL(globalThis.location.href);
  url.searchParams.set("thread", serverId);
  (deps.assign ?? ((u) => globalThis.location.assign(u)))(url.toString());
  return true;
}

const CHUNK_RELOAD_KEY = "scooter-chunk-reload";

/** Reload when an old build's lazy chunk 404s, at most once a minute. */
export function installChunkRecovery(
  check: () => Promise<void>,
  deps: { win?: Window; now?: () => number; reload?: () => void; wouldLoseWork?: () => boolean } = {},
): void {
  const win = deps.win ?? globalThis.window;
  const now = deps.now ?? Date.now;
  win.addEventListener("vite:preloadError", (event) => {
    const last = Number(win.sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
    if (now() - last < 60_000 || (deps.wouldLoseWork ?? reloadWouldLoseWork)()) {
      void check();
      return;
    }
    event.preventDefault();
    win.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now()));
    (deps.reload ?? (() => win.location.reload()))();
  });
}

/** The newer deployed build, if any, and its banner's dismissal. */
export interface UpdateState {
  available: boolean;
  build?: string;
  dismissed: boolean;
}

let state: UpdateState = { available: false, dismissed: false };
const listeners = new Set<() => void>();

function setState(next: UpdateState): void {
  state = next;
  listeners.forEach((l) => l());
}

export const updateStore = {
  get: (): UpdateState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** A dismissal holds until a different build appears. */
  markAvailable(build: string): void {
    if (state.build !== build) setState({ available: true, build, dismissed: false });
  },
  dismiss(): void {
    if (state.available && !state.dismissed) setState({ ...state, dismissed: true });
  },
  /** Back to no known update; tests only. */
  reset(): void {
    setState({ available: false, dismissed: false });
  },
};

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(updateStore.subscribe, updateStore.get, updateStore.get);
}

let sendsInFlight = 0;

/** Keep automatic reloads from cutting off `fn` mid-request. */
export function withReloadHold<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    sendsInFlight++;
    try {
      return await fn(...args);
    } finally {
      sendsInFlight--;
    }
  };
}

// Skips the composer's hidden autosize textarea, which always holds text.
const TEXT_FIELDS = ["textarea", "input:not([type])", 'input[type="text"]', 'input[type="search"]', '[contenteditable="true"]']
  .map((s) => `${s}:not([aria-hidden="true"])`)
  .join(", ");

/** Whether reloading now would lose typed input, a dialog or send. */
export function reloadWouldLoseWork(): boolean {
  if (sendsInFlight > 0 || approvalDraftsHeld()) return true;
  if (document.querySelector('[role="dialog"], [role="alertdialog"], .aui-composer-root .aui-attachment-root')) return true;
  for (const el of document.querySelectorAll<HTMLElement>(TEXT_FIELDS)) {
    const text = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent;
    if (text?.trim()) return true;
  }
  return false;
}

/** The deployed build, or null when /version.json is unreadable. */
export async function fetchDeployedBuild(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl("/version.json", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { build?: unknown };
    return typeof body.build === "string" && body.build ? body.build : null;
  } catch {
    return null;
  }
}

/** This page's build, or null without the meta tag. */
export function pageBuild(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="scooter-build"]')?.content || null;
}
