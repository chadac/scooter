/**
 * Tier 3 E2E for contrib settings tabs: a tab the runtime manifest lists appears in the
 * sidebar in `order`, deep-links and survives a refresh, and a broken tab (an entry the
 * bundle lacks, or a component that throws) shows an error card in that tab only while
 * the others keep working; and a tab's contribFetch reaches the /contrib-api relay. The
 * manifest is served by a route, since the fast stack's vite dev server has none; the
 * modules are the echo contrib's real ui/ files.
 */

import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const ECHO = { contrib: "echo", label: "Echo", order: 15, entry: "echo/ui/SettingsTab.tsx" };

async function serveTabs(page: Page, settingsTabs: Record<string, unknown>) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sources: {}, toolCards: {}, toolTitles: {}, linkProviders: [], approvals: {}, settingsTabs }),
    }),
  );
}

// Below the `desk` breakpoint the tab list is an accordion; open it before clicking.
async function openTabs(page: Page) {
  const toggle = page.locator('[data-testid="settings-tabs-toggle"]');
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
}

const tabIds = (page: Page) =>
  page.locator('[data-testid^="settings-tab-"][role="tab"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid")!.replace("settings-tab-", "")),
  );

test.describe("contrib settings tabs", () => {
  test("a manifest tab appears in order and renders its module", async ({ page }) => {
    await serveTabs(page, { echo: ECHO });
    await page.goto("/settings");
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await openTabs(page);

    // order 15 sits between Scheduled Tasks (10) and Skills (20).
    expect(await tabIds(page)).toEqual(["tasks", "echo", "skills", "hooks", "claude", "appearance", "admin"]);

    await page.locator('[data-testid="settings-tab-echo"]').click();
    await page.waitForURL((u) => u.pathname === "/settings/echo");
    await expect(page.locator('[data-testid="echo-settings-tab"]')).toBeVisible({ timeout: 20_000 });
  });

  test("/settings/echo deep-links and survives a refresh", async ({ page }) => {
    await serveTabs(page, { echo: ECHO });
    await page.goto("/settings/echo");
    await expect(page.locator('[data-testid="echo-settings-tab"]')).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.locator('[data-testid="echo-settings-tab"]')).toBeVisible({ timeout: 20_000 });
    await openTabs(page);
    await expect(page.locator('[data-testid="settings-tab-echo"]')).toHaveAttribute("aria-selected", "true");
  });

  test("without the manifest row, /settings/echo lands on the default tab", async ({ page }) => {
    await serveTabs(page, {});
    await page.goto("/settings/echo");
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible({ timeout: 20_000 });
    await openTabs(page);
    await expect(page.locator('[data-testid="settings-tab-echo"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="settings-tab-tasks"]')).toHaveAttribute("aria-selected", "true");
  });

  for (const [name, broken] of [
    ["an entry missing from the bundle", { ...ECHO, label: "Ghost", entry: "echo/ui/NotInTheBundle.tsx" }],
    ["a component that throws", { ...ECHO, label: "Thrower", entry: "echo/ui/ThrowingTab.tsx" }],
  ] as const) {
    test(`${name} shows an error card in that tab only`, async ({ page }) => {
      await serveTabs(page, { echo: ECHO, "echo-broken": { ...broken, order: 16 } });
      await page.goto("/settings/echo-broken");
      await expect(page.locator('[data-testid="contrib-tab-error"]')).toContainText(
        `The ${broken.label} tab failed to load.`,
        { timeout: 20_000 },
      );

      // The page around it still works: another contrib tab and a built-in both render.
      await openTabs(page);
      await page.locator('[data-testid="settings-tab-echo"]').click();
      await expect(page.locator('[data-testid="echo-settings-tab"]')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-testid="contrib-tab-error"]')).toHaveCount(0);
      await page.locator('[data-testid="settings-tab-skills"]').click();
      await expect(page.locator('[data-testid="settings-panel-skills"]')).toBeVisible();
    });
  }

  // contribFetch: the tab's one round-trip. The broker half is stubbed at the browser,
  // since the fast stack runs no broker; the URL shape is the SDK's contract.
  test("contribFetch reaches /contrib-api/<contrib>/<path> and renders the reply", async ({ page }) => {
    await serveTabs(page, { echo: ECHO });
    let seen = "";
    await page.route("**/contrib-api/echo/whoami", (route) => {
      seen = new URL(route.request().url()).pathname;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: "alice" }) });
    });
    await page.goto("/settings/echo");
    await expect(page.locator('[data-testid="echo-relayed-user"]')).toHaveText("The broker sees alice.", { timeout: 20_000 });
    expect(seen).toBe("/contrib-api/echo/whoami");
  });

  // Unstubbed, the call goes through the dev proxy to the real agent-host, whose relay
  // refuses a caller with no ingress identity before looking anything up.
  test("the real relay refuses an anonymous caller", async ({ page }) => {
    await serveTabs(page, { echo: ECHO });
    await page.goto("/settings/echo");
    await expect(page.locator('[data-testid="echo-relayed-user"]')).toHaveText("The broker sees HTTP 401.", { timeout: 20_000 });
  });
});
