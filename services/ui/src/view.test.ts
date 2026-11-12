/**
 * Settings routing.
 *
 * Settings tabs are real URLs (/settings/<tab>), so the parse/build logic is what
 * makes a tab bookmarkable, refresh-safe and reachable by Back/Forward, including
 * the fallbacks a stale or hand-edited link hits.
 */

import { describe, it, expect } from "vitest";

import { parsePath, pathFor, SETTINGS_TABS, DEFAULT_TAB, settingsTabList, resolveTab } from "./view.js";

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

  it("keeps an unknown slug segment, since it may be a contrib tab", () => {
    // resolveTab decides once the manifest is in; see "tab resolution" below.
    expect(parsePath("/settings/personalization")).toEqual({ view: "settings", tab: "personalization" });
  });

  it("falls back to the default tab for a segment that is not a slug", () => {
    expect(parsePath("/settings/Not_A_Tab")).toEqual({ view: "settings", tab: DEFAULT_TAB });
    expect(parsePath("/settings/%2e%2e")).toEqual({ view: "settings", tab: DEFAULT_TAB });
  });

  it("ignores extra path segments after the tab", () => {
    expect(parsePath("/settings/skills/extra/junk")).toEqual({ view: "settings", tab: "skills" });
  });

  it("does NOT treat a path merely containing 'settings' as the settings view", () => {
    // Only a leading /settings segment routes here; /c/<id>/settings is a sandbox web-service proxy path.
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
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual(["tasks", "skills", "hooks", "claude", "appearance", "conversations", "admin"]);
  });

  it("gives every tab a human label", () => {
    for (const t of SETTINGS_TABS) expect(t.label.length).toBeGreaterThan(0);
  });
});

describe("tab list and resolution", () => {
  const ECHO = { contrib: "echo", label: "Echo", order: 60 };

  it("is the built-ins alone without a manifest", () => {
    expect(settingsTabList({}).map((t) => t.id)).toEqual(SETTINGS_TABS.map((t) => t.id));
  });

  it("places contrib tabs by order, ties broken by id", () => {
    const ids = settingsTabList({
      echo: ECHO,
      "echo-b": { ...ECHO, order: 15 },
      "echo-a": { ...ECHO, order: 15 },
    }).map((t) => t.id);
    expect(ids).toEqual(["tasks", "echo-a", "echo-b", "skills", "hooks", "claude", "appearance", "conversations", "admin", "echo"]);
  });

  it("never lets a contrib row shadow a built-in", () => {
    const list = settingsTabList({ skills: { ...ECHO, label: "Hijack" } });
    expect(list.filter((t) => t.id === "skills")).toEqual([{ id: "skills", label: "Skills", order: 20 }]);
  });

  it("resolves a contrib tab only when the manifest lists it", () => {
    // A deep link to /settings/echo survives a refresh with the manifest loaded, and
    // lands on the default tab on a deployment that does not ship echo.
    expect(resolveTab("echo", settingsTabList({ echo: ECHO }))).toBe("echo");
    expect(resolveTab("echo", settingsTabList({}))).toBe(DEFAULT_TAB);
    expect(resolveTab("skills", settingsTabList({}))).toBe("skills");
  });
});

describe("contrib view routing", () => {
  const views = ["roadmap"];

  it("routes /<view> and /<view>/<path> to that view", () => {
    expect(parsePath("/roadmap", views)).toEqual({ view: "contrib", tab: DEFAULT_TAB, viewId: "roadmap", viewPath: "" });
    expect(parsePath("/roadmap/f1/x/", views)).toEqual({ view: "contrib", tab: DEFAULT_TAB, viewId: "roadmap", viewPath: "f1/x" });
  });

  it("treats a view the manifest does not ship as chat", () => {
    expect(parsePath("/roadmap", []).view).toBe("chat");
    expect(parsePath("/other", views).view).toBe("chat");
  });

  it("round-trips through pathFor", () => {
    expect(pathFor("contrib", DEFAULT_TAB, "roadmap")).toBe("/roadmap");
    expect(pathFor("contrib", DEFAULT_TAB, "roadmap", "f1")).toBe("/roadmap/f1");
    expect(parsePath(pathFor("contrib", DEFAULT_TAB, "roadmap", "f1"), views).viewPath).toBe("f1");
  });
});
