/** Tier 3 E2E: a newer build deployed under an open tab. */

import type { Page } from "@playwright/test";

import { test, expect, seedConversation } from "./fixtures.js";

const banner = '[data-testid="update-banner"]';

async function deployNewerBuild(page: Page) {
  await page.route("**/version.json", (route) => route.fulfill({ json: { build: "newer" } }));
}

test.describe("new UI build", () => {
  test("the banner offers a reload, which loads the new build", async ({ chat, page }) => {
    await deployNewerBuild(page);
    await chat.open();
    await expect(page.locator(banner)).toBeVisible();

    // Now the served build matches the page's own.
    await page.unroute("**/version.json");
    await Promise.all([page.waitForEvent("load"), page.locator('[data-testid="update-reload"]').click()]);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(banner)).toHaveCount(0);
  });

  test("dismissing hides the banner", async ({ chat, page }) => {
    await deployNewerBuild(page);
    await chat.open();
    await page.locator('[data-testid="update-dismiss"]').click();
    await expect(page.locator(banner)).toHaveCount(0);
  });

  test("a sidebar click opens the conversation with a full page load", async ({ chat, page, baseURL, request }) => {
    const id = await seedConversation(request, (baseURL ?? "").replace(/\/$/, ""), null, "Update target");
    await deployNewerBuild(page);
    await chat.open();
    await expect(page.locator(banner)).toBeVisible();
    await page.evaluate(() => ((window as unknown as { beforeClick: boolean }).beforeClick = true));

    await page.unroute("**/version.json");
    const row = page.locator('[data-testid="session-item"]').filter({ hasText: "Update target" });
    await Promise.all([page.waitForEvent("load"), row.getByTestId("session-title").click()]);

    expect(new URL(page.url()).searchParams.get("thread")).toBe(id);
    expect(await page.evaluate(() => (window as unknown as { beforeClick?: boolean }).beforeClick)).toBeUndefined();
    await expect(page.locator('[data-testid="header-conversation-title"]')).toHaveText(/Update target/, { timeout: 20_000 });
  });

  test("with text in the composer, a sidebar click stays in-app", async ({ chat, page, baseURL, request }) => {
    await seedConversation(request, (baseURL ?? "").replace(/\/$/, ""), null, "Draft guard");
    await deployNewerBuild(page);
    await chat.open();
    await expect(page.locator(banner)).toBeVisible();
    await chat.input().fill("not sent yet");
    await page.evaluate(() => ((window as unknown as { beforeClick: boolean }).beforeClick = true));

    const row = page.locator('[data-testid="session-item"]').filter({ hasText: "Draft guard" });
    await row.getByTestId("session-title").click();

    await expect(page.locator('[data-testid="header-conversation-title"]')).toHaveText(/Draft guard/, { timeout: 20_000 });
    expect(await page.evaluate(() => (window as unknown as { beforeClick?: boolean }).beforeClick)).toBe(true);
  });
});
