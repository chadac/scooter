/** Deployment UI themes (scooter.ui.themes), re-read per request. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type Appearance = "light" | "dark";

export interface ThemeVariant {
  appearance: Appearance;
  tokens: Record<string, string>;
}

export interface Theme {
  id: string;
  name: string;
  variants: ThemeVariant[];
}

/** The UI's own theme; deployment themes can't shadow it. */
export const BUILTIN_THEME_ID = "scooter";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const TOKEN = /^[a-z][a-z0-9-]{0,63}$/;
// No `;`, braces, quotes, url() or nesting: can't escape declaration.
const COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,32}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([0-9a-z.%+\-\s,/]*\))$/i;

export class ThemeError extends Error {}

export function isThemeId(v: unknown): v is string {
  return typeof v === "string" && ID.test(v);
}

/** Validate a theme's JSON; `id` is its file name. */
export function parseTheme(id: string, raw: unknown): Theme {
  if (!ID.test(id)) throw new ThemeError(`id must match ${ID}`);
  if (id === BUILTIN_THEME_ID) throw new ThemeError(`"${BUILTIN_THEME_ID}" is the built-in theme`);
  if (typeof raw !== "object" || raw === null) throw new ThemeError("not a JSON object");
  const { name, variants } = raw as { name?: unknown; variants?: unknown };
  if (typeof name !== "string" || name.trim() === "" || name.length > 64) {
    throw new ThemeError("name must be a non-empty string of at most 64 characters");
  }
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 2) {
    throw new ThemeError("variants must hold one or two entries");
  }
  const parsed = variants.map((v, i) => parseVariant(v, i));
  if (parsed.length === 2 && parsed[0].appearance === parsed[1].appearance) {
    throw new ThemeError("a two-variant theme needs one light and one dark variant");
  }
  return { id, name: name.trim(), variants: parsed };
}

function parseVariant(raw: unknown, i: number): ThemeVariant {
  if (typeof raw !== "object" || raw === null) throw new ThemeError(`variants[${i}] is not an object`);
  const { appearance, tokens } = raw as { appearance?: unknown; tokens?: unknown };
  if (appearance !== "light" && appearance !== "dark") {
    throw new ThemeError(`variants[${i}].appearance must be "light" or "dark"`);
  }
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
    throw new ThemeError(`variants[${i}].tokens must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (!TOKEN.test(k)) throw new ThemeError(`variants[${i}].tokens: bad token name "${k}"`);
    if (typeof v !== "string" || !COLOR.test(v.trim())) {
      throw new ThemeError(`variants[${i}].tokens.${k}: not a CSS color`);
    }
    out[k] = v.trim();
  }
  return { appearance, tokens: out };
}

/** Valid themes in `dir` by name; bad files warn and skip. */
export async function loadThemes(dir: string, warn: (msg: string) => void): Promise<Theme[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const themes: Theme[] = [];
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    const id = file.slice(0, -".json".length);
    try {
      const theme = parseTheme(id, JSON.parse(await readFile(join(dir, file), "utf8")));
      for (const msg of contrastWarnings(theme)) warn(`theme ${id}: ${msg}`);
      themes.push(theme);
    } catch (e) {
      warn(`theme ${id}: skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return themes.sort((a, b) => a.name.localeCompare(b.name));
}

// Text tokens that must stay readable on --background.
const TEXT_PAIRS = ["foreground", "muted-foreground", "brand"] as const;

/** WCAG AA misses among hex text tokens only. */
export function contrastWarnings(theme: Theme): string[] {
  const out: string[] = [];
  for (const v of theme.variants) {
    const bg = hexLuminance(v.tokens.background);
    if (bg === undefined) continue;
    for (const fg of TEXT_PAIRS) {
      const l = hexLuminance(v.tokens[fg]);
      if (l === undefined) continue;
      const ratio = (Math.max(bg, l) + 0.05) / (Math.min(bg, l) + 0.05);
      if (ratio < 4.5) out.push(`${v.appearance} ${fg} on background is ${ratio.toFixed(1)}:1, below WCAG AA (4.5:1)`);
    }
  }
  return out;
}

function hexLuminance(color: string | undefined): number | undefined {
  const m = color?.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return undefined;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
