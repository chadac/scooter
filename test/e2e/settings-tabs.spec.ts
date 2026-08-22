/**
 * Tier 3 E2E — the Settings page's tab layout + real URLs.
 *
 * Settings used to be one long scrolling page reachable only by a header toggle. It is
 * now a left tab rail where each tab is a real path (/settings/<tab>), so this asserts
 * the things that change for a user: the tabs exist, clicking one shows only that
 * section AND updates the URL, a pasted deep-link opens the right tab after a full
 * reload, and browser Back/Forward moves between tabs.
 *
 * Also asserts the whole-UI invariants at each step, so navigating settings cannot
 * leave the rest of the app in an inconsistent state.
 */

import { test, expect, snapshot, assertConsistent } from "./fixtures.js";

const TABS = [
  { id: "tasks", label: "Scheduled Tasks" },
  { id: "claude", label: "Bring Your Own Claude" },
  { id: "modules", label: "Modules" },
  { id: "admin", label: "Admin Area" },
];

test.describe("settings page tabs", () => {
  test("the header toggle opens /settings and shows every tab", async ({ chat, page }) => {
    await chat.open();
    await page.locator('[data-testid="settings-toggle"]').click();
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });

    // A real URL, not a hidden view flag. Match on PATHNAME via a predicate: chat's ?thread=
    // deep-link is preserved across the navigation, so a `**/settings/x` glob (which matches the
    // whole URL including the query) would never match.
    await page.waitForURL((u) => u.pathname.startsWith("/settings/"), { timeout: 20_000 });
    for (const t of TABS) {
      await expect(page.locator(`[data-testid="settings-tab-${t.id}"]`), t.id).toHaveText(t.label);
    }
    assertConsistent(await snapshot(page), "settings opened");
  });

  test("clicking a tab shows ONLY that panel and updates the URL", async ({ chat, page }) => {
    await chat.open();
    await page.locator('[data-testid="settings-toggle"]').click();
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });

    for (const t of TABS) {
      await page.locator(`[data-testid="settings-tab-${t.id}"]`).click();
      // The URL carries the tab...
      await page.waitForURL((u) => u.pathname === `/settings/${t.id}`, { timeout: 20_000 });
      // ...the tab is marked selected for assistive tech...
      await expect(page.locator(`[data-testid="settings-tab-${t.id}"]`)).toHaveAttribute("aria-selected", "true");
      // ...and exactly one panel is mounted (this tab's).
      await expect(page.locator(`[data-testid="settings-panel-${t.id}"]`)).toBeVisible();
      await expect(page.locator('[role="tabpanel"]')).toHaveCount(1);
    }
  });

  test("a deep-link to a tab opens it directly after a full page load", async ({ page }) => {
    // The nginx SPA fallback serves index.html for /settings/*; the app re-derives the
    // tab from the path. This is the bookmark / shared-link case.
    await page.goto("/settings/modules");
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="settings-tab-modules"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="settings-panel-modules"]')).toBeVisible();
  });

  test("an UNKNOWN tab segment falls back to the first tab (a stale bookmark still works)", async ({ page }) => {
    await page.goto("/settings/no-such-tab");
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="settings-tab-tasks"]')).toHaveAttribute("aria-selected", "true");
  });

  test("browser BACK and FORWARD move between tabs, then back to chat", async ({ chat, page }) => {
    await chat.open();
    await page.locator('[data-testid="settings-toggle"]').click();
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="settings-tab-modules"]').click();
    await page.waitForURL((u) => u.pathname === "/settings/modules", { timeout: 20_000 });

    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/settings/tasks", { timeout: 20_000 });
    await expect(page.locator('[data-testid="settings-tab-tasks"]')).toHaveAttribute("aria-selected", "true");

    await page.goForward();
    await page.waitForURL((u) => u.pathname === "/settings/modules", { timeout: 20_000 });

    // All the way back out to the chat view.
    await page.goBack();
    await page.goBack();
    await expect(page.locator('[data-testid="settings-page"]')).toHaveCount(0, { timeout: 20_000 });
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
  });

  test("the Bring Your Own Claude tab always renders something actionable", async ({ page }) => {
    // This stack runs WITH BYO enabled, so the ENABLED path is what renders here. The disabled
    // path (a red panel + kubenix sample) is unit-tested; asserting it here would test a state
    // this deployment cannot produce — my first cut did exactly that and failed for the wrong
    // reason.
    //
    // What matters at this level either way: the tab is NEVER BLANK. It used to `return null`
    // when BYO was off, which reads as a broken page rather than "off by config".
    await page.goto("/settings/claude");
    await expect(page.locator('[data-testid="settings-panel-claude"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="claude-agent-section"]')).toBeVisible();

    const text = (await page.locator('[data-testid="settings-panel-claude"]').innerText()).trim();
    expect(text.length, "the claude tab must never render blank").toBeGreaterThan(40);

    // And it must not leak a raw parser error where the device list goes — /byoc/* does not exist
    // on this stack, so the SPA catch-all returns index.html and res.json() used to throw
    // `Unexpected token '<', "<!doctype "...` straight into the UI.
    expect(text, "a JSON parser error must never reach the user").not.toMatch(/Unexpected token|not valid JSON/i);
  });

  test("the Admin Area tab contains the Users directory", async ({ page }) => {
    await page.goto("/settings/admin");
    await expect(page.locator('[data-testid="admin-area"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="users-section"]')).toBeVisible();
  });

  test("leaving settings returns to chat with the app still consistent", async ({ chat, page }) => {
    await chat.open();
    await chat.completeTurn("a turn before visiting settings");
    const before = await snapshot(page);

    await page.locator('[data-testid="settings-toggle"]').click();
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="settings-back"]').click();

    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    const after = await snapshot(page);
    assertConsistent(after, "back from settings");
    // The conversation survived the round trip — settings must not disturb the thread.
    expect(after.userMessages, "transcript preserved across settings").toBe(before.userMessages);
  });
});
