/**
 * Tier 1 (ui) — settings routing.
 *
 * Settings moved from a hidden view toggle to real URLs (/settings/<tab>), so the
 * parse/build logic is what makes a tab bookmarkable, refresh-safe and reachable by
 * Back/Forward. These lock that behaviour, including the fallbacks a stale or
 * hand-edited link hits.
 */

import { describe, it, expect } from "vitest";

import { parsePath, pathFor, SETTINGS_TABS, DEFAULT_TAB } from "./view.js";

describe("settings path parsing", () => {
  it("routes the root (and chat deep-links) to chat", () => {
    expect(parsePath("/")).toEqual({ view: "chat", tab: DEFAULT_TAB });
    expect(parsePath("")).toEqual({ view: "chat", tab: DEFAULT_TAB });
  });

  it("routes bare /settings to the first tab", () => {
    expect(parsePath("/settings")).toEqual({ view: "settings", tab: DEFAULT_TAB });
    expect(parsePath("/settings/")).toEqual({ view: "settings", tab: DEFAULT_TAB });
  });

  it("routes /settings/<tab> to that tab, for every declared tab", () => {
    for (const t of SETTINGS_TABS) {
      expect(parsePath(`/settings/${t.id}`), t.id).toEqual({ view: "settings", tab: t.id });
    }
  });

  it("falls back to the default tab for an UNKNOWN settings segment", () => {
    // A stale bookmark or a renamed tab must still land somewhere usable, not blank.
    expect(parsePath("/settings/does-not-exist")).toEqual({ view: "settings", tab: DEFAULT_TAB });
  });

  it("ignores extra path segments after the tab", () => {
    expect(parsePath("/settings/claude/extra/junk")).toEqual({ view: "settings", tab: "claude" });
  });

  it("does NOT treat a path merely containing 'settings' as the settings view", () => {
    // Only a leading /settings segment routes here — /c/<id>/settings is a sandbox
    // web-service proxy path, not this page.
    expect(parsePath("/c/abc/settings").view).toBe("chat");
  });
});

describe("settings path building", () => {
  it("round-trips every tab through pathFor -> parsePath", () => {
    for (const t of SETTINGS_TABS) {
      expect(parsePath(pathFor("settings", t.id))).toEqual({ view: "settings", tab: t.id });
    }
  });

  it("builds the chat path as the root", () => {
    expect(pathFor("chat")).toBe("/");
  });

  it("defaults to the first tab when none is given", () => {
    expect(pathFor("settings")).toBe(`/settings/${DEFAULT_TAB}`);
  });
});

describe("tab declaration", () => {
  it("declares the expected tabs in sidebar order", () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual(["tasks", "claude", "admin"]);
  });

  it("gives every tab a human label", () => {
    for (const t of SETTINGS_TABS) expect(t.label.length).toBeGreaterThan(0);
  });
});
