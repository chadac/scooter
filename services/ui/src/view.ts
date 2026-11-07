/**
 * Top-level view and settings routing: a small useSyncExternalStore store (the app has
 * no router) that also owns the settings path so settings has bookmarkable URLs.
 *
 *   /                     -> chat
 *   /settings             -> settings, first tab
 *   /settings/<tab>       -> settings, that tab (built-in or contrib; see resolveTab)
 *   /<view>[/<path>]      -> a contrib view from the manifest (`ui.views`), reading `path`
 *
 * Navigation uses history.pushState and listens to popstate so Back/Forward work, and
 * nginx serves the SPA with `try_files $uri $uri/ /index.html` so a hard refresh on a
 * deep link re-derives the tab from the path.
 */

import { useSyncExternalStore } from "react";

import { contribViews } from "./contribManifest.js";

export type View = "chat" | "settings" | "contrib";

/** Where the app is; `viewId` and `viewPath` are set only on a contrib view. */
export interface Route {
  view: View;
  tab: SettingsTab;
  viewId?: string;
  viewPath?: string;
}

/** The built-in settings tabs; `id` is the URL segment and `order` places them among
 *  contrib tabs (contrib/README.md tells contribs to pick around these). */
export const SETTINGS_TABS = [
  { id: "tasks", label: "Scheduled Tasks", order: 10 },
  { id: "skills", label: "Skills", order: 20 },
  { id: "hooks", label: "Hooks", order: 25 },
  { id: "claude", label: "Bring Your Own Claude", order: 30 },
  { id: "admin", label: "Admin Area", order: 50 },
] as const;

export type BuiltinTab = (typeof SETTINGS_TABS)[number]["id"];

/** A settings tab id: a built-in, or a contrib tab from the runtime manifest. A string
 *  because contrib tabs are only known once the manifest has loaded. */
export type SettingsTab = string;

export const DEFAULT_TAB: BuiltinTab = "tasks";

/** Every tab id, built-in or contrib, is a URL slug (contrib/settings-tabs.nix). */
const TAB_SLUG = /^[a-z][a-z0-9-]*$/;

export const isBuiltinTab = (v: string): v is BuiltinTab => SETTINGS_TABS.some((t) => t.id === v);

/** Parse a pathname into the view and tab. A slug-shaped segment is kept as-is even if it
 *  is not a built-in, since it may be a contrib tab; resolveTab decides once the manifest
 *  is in. Anything else falls back to the default tab. A first segment naming one of
 *  `views` is that contrib view, and the rest of the path is its own. */
export function parsePath(pathname: string, views: readonly string[] = Object.keys(contribViews())): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] && views.includes(parts[0])) {
    return { view: "contrib", tab: DEFAULT_TAB, viewId: parts[0], viewPath: parts.slice(1).join("/") };
  }
  if (parts[0] !== "settings") return { view: "chat", tab: DEFAULT_TAB };
  const seg = parts[1] ?? "";
  return { view: "settings", tab: TAB_SLUG.test(seg) ? seg : DEFAULT_TAB };
}

/** One row of the settings sidebar. `contrib` is set for a contrib tab. */
export interface TabRow {
  id: SettingsTab;
  label: string;
  order: number;
  contrib?: string;
}

/** The sidebar: built-ins plus the manifest's contrib tabs, by `order` then id. A contrib
 *  tab can never shadow a built-in (the eval refuses the collision; this is the backstop). */
export function settingsTabList(
  contribTabs: Record<string, { contrib: string; label: string; order: number }>,
): TabRow[] {
  const rows: TabRow[] = SETTINGS_TABS.map((t) => ({ id: t.id, label: t.label, order: t.order }));
  for (const [id, t] of Object.entries(contribTabs)) {
    if (!isBuiltinTab(id)) rows.push({ id, label: t.label, order: t.order, contrib: t.contrib });
  }
  return rows.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The tab to show for a parsed id: itself if it is in the list, else the default (a stale
 *  bookmark, a renamed tab, or a contrib this deployment does not ship). */
export function resolveTab(tab: SettingsTab, list: readonly TabRow[]): SettingsTab {
  return list.some((t) => t.id === tab) ? tab : DEFAULT_TAB;
}

/** The URL for a route — the single place paths are constructed. */
export function pathFor(view: View, tab: SettingsTab = DEFAULT_TAB, viewId?: string, viewPath = ""): string {
  if (view === "contrib" && viewId) return viewPath ? `/${viewId}/${viewPath}` : `/${viewId}`;
  return view === "settings" ? `/settings/${tab}` : "/";
}

let state: Route = parsePath(globalThis.location?.pathname ?? "/");
let snapshot = state; // stable reference for useSyncExternalStore
const listeners = new Set<() => void>();
const emit = () => {
  snapshot = state;
  listeners.forEach((l) => l());
};

const same = (a: Route, b: Route) =>
  a.view === b.view && a.tab === b.tab && a.viewId === b.viewId && a.viewPath === b.viewPath;

/** Apply a state change and push it to the URL; `replace` skips the history entry. */
function go(next: Route, replace = false) {
  if (same(next, state)) return;
  state = next;
  const url = new URL(globalThis.location.href);
  url.pathname = pathFor(next.view, next.tab, next.viewId, next.viewPath);
  // Preserving ?thread= means Back to chat restores the same conversation.
  if (!replace) globalThis.history.pushState(null, "", url);
  emit();
}

/** A view path without leading or trailing slashes. */
const trimSlashes = (p: string) => p.split("/").filter(Boolean).join("/");

export const viewStore = {
  /** Switch the top-level view; settings lands on the default tab. */
  set(v: View) {
    go({ view: v, tab: v === "settings" ? DEFAULT_TAB : state.tab });
  },
  /** Open settings on a specific tab. */
  setTab(tab: SettingsTab) {
    go({ view: "settings", tab });
  },
  /** Open a contrib view, at `path` within it. */
  openView(viewId: string, path = "") {
    go({ view: "contrib", tab: state.tab, viewId, viewPath: trimSlashes(path) });
  },
  get(): View {
    return state.view;
  },
  getTab(): SettingsTab {
    return state.tab;
  },
  /** Re-derive from the current URL — for popstate (Back/Forward), and once the manifest
   *  has named the contrib views. */
  syncFromUrl() {
    const next = parsePath(globalThis.location?.pathname ?? "/");
    if (same(next, state)) return;
    state = next;
    emit();
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

// Browser Back/Forward must move between chat and settings tabs.
globalThis.addEventListener?.("popstate", () => viewStore.syncFromUrl());

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useView(): View {
  return useSyncExternalStore(subscribe, () => snapshot.view, () => snapshot.view);
}

export function useSettingsTab(): SettingsTab {
  return useSyncExternalStore(subscribe, () => snapshot.tab, () => snapshot.tab);
}

/** The whole route, for a contrib view's id and path. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
