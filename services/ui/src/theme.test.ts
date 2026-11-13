// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "./theme.js";

const NORD: Theme = {
  id: "nord",
  name: "Nord",
  variants: [
    { appearance: "light", tokens: { background: "#eceff4" } },
    { appearance: "dark", tokens: { background: "#2e3440", brand: "#88c0d0" } },
  ],
};
const NIGHT: Theme = { id: "night", name: "Night", variants: [{ appearance: "dark", tokens: { background: "#000000" } }] };

// The store reads localStorage at import; import it fresh.
async function load() {
  vi.resetModules();
  return import("./theme.js");
}

const html = () => document.documentElement;
const style = () => document.getElementById("scooter-theme")?.textContent ?? "";
const cache = () => JSON.parse(localStorage.getItem("scooter-theme-css") ?? "null") as Record<string, string> | null;

beforeEach(() => {
  localStorage.clear();
  html().className = "";
  document.getElementById("scooter-theme")?.remove();
});

describe("theme store", () => {
  it("defaults to the built-in theme with no overrides", async () => {
    const { themeStore } = await load();
    expect(themeStore.get()).toMatchObject({ themeId: undefined, defaultId: "scooter", mode: "system" });
    expect(style()).toBe("");
    expect(html().classList.contains("dark")).toBe(false);
  });

  it("applies the selected theme's variant for the mode", async () => {
    const { themeStore } = await load();
    themeStore.setThemes([NORD]);
    themeStore.setTheme("nord");
    expect(style()).toBe(":root:root{--background:#eceff4;}");
    themeStore.setMode("dark");
    expect(html().classList.contains("dark")).toBe(true);
    expect(style()).toBe(":root:root{--background:#2e3440;--brand:#88c0d0;}");
    expect(cache()).toEqual({ light: ":root:root{--background:#eceff4;}", dark: ":root:root{--background:#2e3440;--brand:#88c0d0;}" });
  });

  it("a single-variant theme pins its appearance whatever the mode", async () => {
    const { themeStore } = await load();
    themeStore.setThemes([NIGHT]);
    themeStore.setMode("light");
    themeStore.setTheme("night");
    expect(html().classList.contains("dark")).toBe(true);
    expect(cache()).toEqual({ fixed: "dark", dark: ":root:root{--background:#000000;}" });
  });

  it("keeps the cached paint until the deployment's themes arrive", async () => {
    localStorage.setItem("scooter-theme-id", "nord");
    localStorage.setItem("scooter-theme-css", JSON.stringify({ light: ":root:root{--background:#eceff4;}" }));
    const { themeStore } = await load();
    expect(style()).toBe(":root:root{--background:#eceff4;}");
    themeStore.setThemes([NORD]);
    expect(style()).toBe(":root:root{--background:#eceff4;}");
  });

  it("falls back to the built-in when the saved theme is gone", async () => {
    localStorage.setItem("scooter-theme-id", "removed");
    localStorage.setItem("scooter-theme-css", JSON.stringify({ light: ":root:root{--background:#123456;}" }));
    const { themeStore, activeTheme } = await load();
    themeStore.setThemes([NORD]);
    expect(activeTheme().id).toBe("scooter");
    expect(style()).toBe("");
    expect(cache()).toEqual({});
  });

  it("follows the deployment default until the user picks", async () => {
    const { themeStore, activeTheme } = await load();
    const save = vi.fn();
    themeStore.onChange(save);
    themeStore.setThemes([NORD, NIGHT], "nord");
    expect(activeTheme().id).toBe("nord");
    expect(style()).toBe(":root:root{--background:#eceff4;}");
    themeStore.setTheme("nord");
    expect(save.mock.calls).toEqual([[{ themeId: "nord" }]]);
    themeStore.setThemes([NORD, NIGHT], "night");
    expect(activeTheme().id).toBe("nord");
  });

  it("an account with no saved theme clears this browser's pick", async () => {
    localStorage.setItem("scooter-theme-id", "scooter");
    const { themeStore, activeTheme } = await load();
    themeStore.setThemes([NORD], "nord");
    expect(activeTheme().id).toBe("scooter");
    themeStore.adopt({ mode: "system" });
    expect(localStorage.getItem("scooter-theme-id")).toBeNull();
    expect(activeTheme().id).toBe("nord");
  });

  it("saves user picks through onChange, but not an adopted account choice", async () => {
    const { themeStore } = await load();
    const save = vi.fn();
    themeStore.onChange(save);
    themeStore.setThemes([NORD]);
    themeStore.adopt({ themeId: "nord", mode: "dark" });
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.getItem("scooter-theme-id")).toBe("nord");
    expect(localStorage.getItem("scooter-theme")).toBe("dark");
    themeStore.setMode("light");
    themeStore.setTheme("scooter");
    expect(save.mock.calls).toEqual([[{ mode: "light" }], [{ themeId: "scooter" }]]);
  });
});
