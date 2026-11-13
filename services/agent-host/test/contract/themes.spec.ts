/** Deployment theme files (scooter.ui.themes): validation, loading and contrast warnings. */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contrastWarnings, loadDefaultThemeId, loadThemes, parseTheme, ThemeError } from "../../src/theme/themes.js";

const pair = {
  name: "Solarized",
  variants: [
    { appearance: "light", tokens: { background: "#fdf6e3", foreground: "#073642" } },
    { appearance: "dark", tokens: { background: "#002b36", foreground: "#93a1a1" } },
  ],
};

describe("parseTheme", () => {
  it("accepts a light/dark pair and a single variant", () => {
    expect(parseTheme("solarized", pair).variants).toHaveLength(2);
    expect(parseTheme("night", { name: "Night", variants: [{ appearance: "dark", tokens: {} }] }).variants).toHaveLength(1);
  });

  it("accepts the CSS color syntaxes", () => {
    const tokens = { a: "#abc", b: "rgb(1 2 3 / 50%)", c: "oklch(0.7 0.1 200)", d: "hsl(10, 20%, 30%)", e: "rebeccapurple" };
    expect(parseTheme("t", { name: "T", variants: [{ appearance: "light", tokens }] }).variants[0].tokens).toEqual(tokens);
  });

  it.each([
    ["a declaration break", "#fff;}body{display:none"],
    ["url()", "url(https://evil.example/beacon)"],
    ["var()", "var(--x)"],
    ["nested parens", "rgb(calc(1) 2 3)"],
    ["a quote", '"red"'],
  ])("rejects %s in a token value", (_label, value) => {
    expect(() => parseTheme("t", { name: "T", variants: [{ appearance: "light", tokens: { background: value } }] })).toThrow(ThemeError);
  });

  it.each([
    ["the built-in id", "scooter", pair],
    ["a bad id", "Bad_Id", pair],
    ["no name", "t", { variants: pair.variants }],
    ["no variants", "t", { name: "T", variants: [] }],
    ["three variants", "t", { name: "T", variants: [...pair.variants, pair.variants[0]] }],
    ["two light variants", "t", { name: "T", variants: [pair.variants[0], pair.variants[0]] }],
    ["a bad appearance", "t", { name: "T", variants: [{ appearance: "dim", tokens: {} }] }],
    ["a bad token name", "t", { name: "T", variants: [{ appearance: "light", tokens: { "--bg": "#fff" } }] }],
  ])("rejects %s", (_label, id, raw) => {
    expect(() => parseTheme(id, raw)).toThrow(ThemeError);
  });
});

describe("loadThemes", () => {
  it("reads every .json file, skipping and warning on bad ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "themes-"));
    writeFileSync(join(dir, "solarized.json"), JSON.stringify(pair));
    writeFileSync(join(dir, "broken.json"), "{");
    writeFileSync(join(dir, "README"), "not a theme");
    const warnings: string[] = [];
    const themes = await loadThemes(dir, (m) => warnings.push(m));
    expect(themes.map((t) => t.id)).toEqual(["solarized"]);
    expect(warnings).toEqual([expect.stringMatching(/^theme broken: skipped/)]);
  });

  it("follows a ConfigMap mount's symlinks and ignores its ..data entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "themes-"));
    mkdirSync(join(dir, "..2026_11_10"));
    writeFileSync(join(dir, "..2026_11_10", "solarized.json"), JSON.stringify(pair));
    symlinkSync("..2026_11_10", join(dir, "..data"));
    symlinkSync("..data/solarized.json", join(dir, "solarized.json"));
    expect((await loadThemes(dir, () => {})).map((t) => t.id)).toEqual(["solarized"]);
  });

  it("is empty when the directory is absent", async () => {
    expect(await loadThemes(join(tmpdir(), "no-such-themes-dir"), () => {})).toEqual([]);
  });
});

describe("loadDefaultThemeId", () => {
  const solarized = parseTheme("solarized", pair);
  const at = (value?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "themes-"));
    if (value !== undefined) writeFileSync(join(dir, "default"), value);
    return dir;
  };

  it("names a loaded theme or the built-in", async () => {
    expect(await loadDefaultThemeId(at("solarized\n"), [solarized], () => {})).toBe("solarized");
    expect(await loadDefaultThemeId(at("scooter"), [solarized], () => {})).toBe("scooter");
  });

  it("is the built-in when unset", async () => {
    expect(await loadDefaultThemeId(at(), [solarized], () => {})).toBe("scooter");
  });

  it("falls back to the built-in, warning, when the theme didn't load", async () => {
    const warnings: string[] = [];
    expect(await loadDefaultThemeId(at("broken"), [solarized], (m) => warnings.push(m))).toBe("scooter");
    expect(warnings).toEqual([expect.stringMatching(/default theme broken/)]);
  });
});

describe("contrastWarnings", () => {
  it("flags hex text tokens below WCAG AA on the background", () => {
    // Canonical Solarized Light muted ink: base1 on base3.
    const theme = parseTheme("t", { name: "T", variants: [{ appearance: "light", tokens: { background: "#fdf6e3", "muted-foreground": "#93a1a1" } }] });
    expect(contrastWarnings(theme)).toEqual([expect.stringMatching(/^light muted-foreground on background is 2\.\d:1/)]);
  });

  it("passes readable pairs and skips non-hex colors", () => {
    expect(contrastWarnings(parseTheme("solarized", pair))).toEqual([]);
    const oklch = parseTheme("t", { name: "T", variants: [{ appearance: "light", tokens: { background: "oklch(1 0 0)", foreground: "#eee" } }] });
    expect(contrastWarnings(oklch)).toEqual([]);
  });
});
