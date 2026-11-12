/**
 * Tier 3 E2E for the Settings page's tab layout and real URLs: the tabs exist, clicking one
 * shows only that section and updates the URL (/settings/<tab>), a pasted deep-link opens
 * the right tab after a full reload, and browser Back/Forward moves between tabs. Also
 * asserts the whole-UI invariants at each step.
 */

import { type Page } from "@playwright/test";
import { test, expect, snapshot, assertConsistent } from "./fixtures.js";

// Below the `desk` breakpoint the tabs are an accordion that must be opened before the
// tab buttons can be clicked; at or above it the trigger is hidden, so this is a no-op.
async function openTabs(page: Page) {
  const toggle = page.locator('[data-testid="settings-tabs-toggle"]');
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
}

const TABS = [
  { id: "tasks", label: "Scheduled Tasks" },
  { id: "skills", label: "Skills" },
  { id: "claude", label: "Bring Your Own Claude" },
  { id: "appearance", label: "Appearance" },
  { id: "conversations", label: "Conversations" },
  { id: "admin", label: "Admin Area" },
];

test.describe("settings page tabs", () => {
  // The round-trip test opens with a completeTurn, which on the full target funds a sandbox boot.
  test.setTimeout(120_000);

  test("the header toggle opens /settings and shows every tab", async ({ chat, page }) => {
    await chat.open();
    await page.locator('[data-testid="settings-toggle"]').click();
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });

    // A real URL, matched on pathname because the chat's ?thread= deep-link is preserved
    // across the navigation.
    await page.waitForURL((u) => u.pathname.startsWith("/settings/"), { timeout: 20_000 });
    await openTabs(page);
    for (const t of TABS) {
      await expect(page.locator(`[data-testid="settings-tab-${t.id}"]`), t.id).toHaveText(t.label);
    }
    assertConsistent(await snapshot(page), "settings opened");
  });

  test("clicking a tab shows ONLY that panel and updates the URL", async ({ chat, page }) => {
    await chat.open();
    await page.locator('[data-testid="settings-toggle"]').click();
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await openTabs(page);

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
    // The nginx SPA fallback serves index.html for /settings/* and the app re-derives the
    // tab from the path.
    await page.goto("/settings/claude");
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await openTabs(page);
    await expect(page.locator('[data-testid="settings-tab-claude"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="settings-panel-claude"]')).toBeVisible();
  });

  test("an UNKNOWN tab segment falls back to the first tab (a stale bookmark still works)", async ({ page }) => {
    await page.goto("/settings/no-such-tab");
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await openTabs(page);
    await expect(page.locator('[data-testid="settings-tab-tasks"]')).toHaveAttribute("aria-selected", "true");
  });

  test("browser BACK and FORWARD move between tabs, then back to chat", async ({ chat, page }) => {
    await chat.open();
    await page.locator('[data-testid="settings-toggle"]').click();
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await openTabs(page);
    await page.locator('[data-testid="settings-tab-claude"]').click();
    await page.waitForURL((u) => u.pathname === "/settings/claude", { timeout: 20_000 });

    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/settings/tasks", { timeout: 20_000 });
    await expect(page.locator('[data-testid="settings-tab-tasks"]')).toHaveAttribute("aria-selected", "true");

    await page.goForward();
    await page.waitForURL((u) => u.pathname === "/settings/claude", { timeout: 20_000 });

    // All the way back out to the chat view.
    await page.goBack();
    await page.goBack();
    await expect(page.locator('[data-testid="settings-page"]')).toHaveCount(0, { timeout: 20_000 });
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
  });

  test("the Bring Your Own Claude tab always renders something actionable", async ({ page }) => {
    // The fast stack runs with BYO enabled and the full target leaves it off, so the
    // assertions are branch-agnostic: the tab must never render blank.
    await page.goto("/settings/claude");
    await expect(page.locator('[data-testid="settings-panel-claude"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="claude-agent-section"]')).toBeVisible();

    const text = (await page.locator('[data-testid="settings-panel-claude"]').innerText()).trim();
    expect(text.length, "the claude tab must never render blank").toBeGreaterThan(40);

    // It must not leak a raw parser error where the device list goes (the SPA catch-all
    // returns index.html for /byoc/*).
    expect(text, "a JSON parser error must never reach the user").not.toMatch(/Unexpected token|not valid JSON/i);
  });

  test("the Admin Area tab contains the Users directory", async ({ page }) => {
    await page.goto("/settings/admin");
    await expect(page.locator('[data-testid="admin-area"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="users-section"]')).toBeVisible();
  });

  test("leaving settings returns to chat with the app still consistent", async ({ chat, page }) => {
    // The only test in this file that runs a turn, so the only one that funds a sandbox boot.
    test.setTimeout(180_000);
    await chat.open();
    await chat.completeTurn("a turn before visiting settings");
    const before = await snapshot(page);

    await page.locator('[data-testid="settings-toggle"]').click();
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="settings-back"]').click();

    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    const after = await snapshot(page);
    assertConsistent(after, "back from settings");
    // The conversation survived the round trip; settings must not disturb the thread.
    expect(after.userMessages, "transcript preserved across settings").toBe(before.userMessages);
  });
});
