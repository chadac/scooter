/** Paints the chosen theme on <html>; index.html mirrors it pre-paint. */
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type Appearance = "light" | "dark";

export interface ThemeVariant {
  appearance: Appearance;
  /** Token name without `--` to color; unset ones use globals.css. */
  tokens: Record<string, string>;
}

export interface Theme {
  id: string;
  name: string;
  variants: ThemeVariant[];
}

/** The account-wide choice, as GET/PATCH /user-theme carry it. */
export interface ThemeChoice {
  /** Absent follows the deployment's default. */
  themeId?: string;
  mode: ThemeMode;
}

/** globals.css's own tokens, so no overrides. */
export const BUILTIN_THEME: Theme = {
  id: "scooter",
  name: "Scooter",
  variants: [
    { appearance: "light", tokens: {} },
    { appearance: "dark", tokens: {} },
  ],
};

const MODE_KEY = "scooter-theme";
const THEME_KEY = "scooter-theme-id";
const CSS_KEY = "scooter-theme-css";
const STYLE_ID = "scooter-theme";

/** What index.html reads before first paint. */
interface PaintCache {
  /** The appearance a single-variant theme pins. */
  fixed?: Appearance;
  light?: string;
  dark?: string;
}

export interface ThemeState {
  mode: ThemeMode;
  /** The user's pick; undefined follows `defaultId`. */
  themeId?: string;
  /** scooter.ui.defaultTheme. */
  defaultId: string;
  /** The built-in first, then the deployment's. */
  themes: readonly Theme[];
  /** Whether the deployment's themes have been fetched yet. */
  loaded: boolean;
}

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // localStorage can throw (private mode / disabled).
    return null;
  }
}

function write(key: string, value: string) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Best-effort; the in-memory state still drives the UI.
  }
}

function remove(key: string) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Best-effort, as in write().
  }
}

function isMode(v: unknown): v is ThemeMode {
  return v === "light" || v === "dark" || v === "system";
}

function readCache(): PaintCache {
  try {
    const v = JSON.parse(read(CSS_KEY) ?? "null") as unknown;
    return typeof v === "object" && v !== null ? (v as PaintCache) : {};
  } catch {
    return {};
  }
}

const storedMode = read(MODE_KEY);
let state: ThemeState = {
  mode: isMode(storedMode) ? storedMode : "system",
  themeId: read(THEME_KEY) ?? undefined,
  defaultId: BUILTIN_THEME.id,
  themes: [BUILTIN_THEME],
  loaded: false,
};

const listeners = new Set<() => void>();
const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
let persist: ((choice: Partial<ThemeChoice>) => void) | undefined;

/** The user's pick, else the deployment default, else the built-in. */
export function activeTheme(s: ThemeState = state): Theme {
  const find = (id: string | undefined) => s.themes.find((t) => t.id === id);
  return find(s.themeId) ?? find(s.defaultId) ?? BUILTIN_THEME;
}

/** The appearance a single-variant theme pins, else undefined. */
export function fixedAppearance(theme: Theme): Appearance | undefined {
  return theme.variants.length === 1 ? theme.variants[0].appearance : undefined;
}

function modeAppearance(mode: ThemeMode): Appearance {
  if (mode === "system") return media?.matches ? "dark" : "light";
  return mode;
}

/** A rule overriding globals.css; `:root:root` outranks its `.dark`. */
export function variantCss(variant: ThemeVariant): string {
  const decls = Object.entries(variant.tokens).map(([k, v]) => `--${k}:${v};`);
  return decls.length ? `:root:root{${decls.join("")}}` : "";
}

function paint(appearance: Appearance, css: string | undefined) {
  const doc = globalThis.document;
  if (!doc) return;
  doc.documentElement.classList.toggle("dark", appearance === "dark");
  let el = doc.getElementById(STYLE_ID);
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.append(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/** Converge <html> to the state; idempotent. */
function apply() {
  // Unfetched deployment theme: keep index.html's cached paint.
  if (!state.loaded && state.themeId !== BUILTIN_THEME.id) {
    const cache = readCache();
    const appearance = cache.fixed ?? modeAppearance(state.mode);
    paint(appearance, cache[appearance]);
    return;
  }
  const theme = activeTheme();
  const fixed = fixedAppearance(theme);
  const appearance = fixed ?? modeAppearance(state.mode);
  const cache: PaintCache = { ...(fixed ? { fixed } : {}) };
  for (const v of theme.variants) {
    const css = variantCss(v);
    if (css) cache[v.appearance] = css;
  }
  write(CSS_KEY, JSON.stringify(cache));
  paint(appearance, cache[appearance]);
}

function update(next: Partial<ThemeState>) {
  state = { ...state, ...next };
  apply();
  for (const cb of listeners) cb();
}

media?.addEventListener?.("change", () => {
  if (state.mode === "system") update({});
});

apply();

export const themeStore = {
  get(): ThemeState {
    return state;
  },
  /** Saved locally and to the account. */
  setMode(mode: ThemeMode) {
    if (mode === state.mode) return;
    write(MODE_KEY, mode);
    update({ mode });
    persist?.({ mode });
  },
  /** Saved locally and to the account. */
  setTheme(themeId: string) {
    if (themeId === state.themeId) return;
    write(THEME_KEY, themeId);
    update({ themeId });
    persist?.({ themeId });
  },
  /** The deployment's themes and default, from GET /themes. */
  setThemes(themes: readonly Theme[], defaultId: string = BUILTIN_THEME.id) {
    update({ themes: [BUILTIN_THEME, ...themes.filter((t) => t.id !== BUILTIN_THEME.id)], defaultId, loaded: true });
  },
  /** Take the account's saved choice without saving it back; no theme follows the default. */
  adopt(choice: Partial<ThemeChoice>) {
    const next: Partial<ThemeState> = {};
    if (choice.themeId !== state.themeId) {
      if (choice.themeId) write(THEME_KEY, choice.themeId);
      else remove(THEME_KEY);
      next.themeId = choice.themeId;
    }
    if (isMode(choice.mode) && choice.mode !== state.mode) {
      write(MODE_KEY, choice.mode);
      next.mode = choice.mode;
    }
    if (Object.keys(next).length) update(next);
  },
  /** Saves setMode/setTheme picks; unset keeps them in this browser. */
  onChange(save: ((choice: Partial<ThemeChoice>) => void) | undefined) {
    persist = save;
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

export function useThemeState(): ThemeState {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get, themeStore.get);
}

/** The current mode ("light" | "dark" | "system"). */
export function useTheme(): ThemeMode {
  return useThemeState().mode;
}
