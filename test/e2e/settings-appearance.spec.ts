/** E2E: deployment themes, repainting, and the account-saved choice. */

import { type Browser, type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const uniqueUser = () => `e2e-theme-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** Own user per test: theme choices are per account. */
async function pageAs(browser: Browser, user: string): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-auth-user": user } });
  return context.newPage();
}

async function openAppearance(page: Page) {
  await page.goto("/settings/appearance");
  await expect(page.locator('[data-testid="appearance-section"]')).toBeVisible({ timeout: 20_000 });
}

const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim());
const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));

test.describe("settings — appearance", () => {
  test.setTimeout(90_000);

  test("lists the built-in theme and the deployment's", async ({ browser }) => {
    const page = await pageAs(browser, uniqueUser());
    await openAppearance(page);
    for (const id of ["scooter", "ocean", "midnight"]) {
      await expect(page.locator(`[data-testid="theme-option-${id}"]`), id).toBeVisible();
    }
    await expect(page.locator('[data-testid="theme-option-scooter"]')).toHaveAttribute("aria-checked", "true");
    await page.context().close();
  });

  test("a picked theme and mode repaint the page and follow the account to a new browser", async ({ browser }) => {
    const user = uniqueUser();
    const page = await pageAs(browser, user);
    await openAppearance(page);

    await page.locator('[data-testid="theme-option-ocean"]').click();
    await page.locator('[data-testid="theme-mode-dark"]').click();
    await expect.poll(() => background(page)).toBe("#0b1d2a");
    expect(await isDark(page)).toBe(true);
    await expect(page.locator('[data-testid="theme-mode-dark"]')).toHaveAttribute("aria-checked", "true");

    // No localStorage here, so the paint comes from the account.
    const save = page.waitForResponse((r) => r.url().endsWith("/user-theme") && r.request().method() === "PATCH");
    await page.locator('[data-testid="theme-mode-light"]').click();
    await save;
    await page.context().close();

    const other = await pageAs(browser, user);
    await openAppearance(other);
    await expect(other.locator('[data-testid="theme-option-ocean"]')).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => background(other)).toBe("#eef6fb");
    expect(await isDark(other)).toBe(false);
    await other.context().close();
  });

  test("a single-variant theme pins its appearance and the header toggle names it", async ({ browser }) => {
    const page = await pageAs(browser, uniqueUser());
    await openAppearance(page);
    await page.locator('[data-testid="theme-mode-light"]').click();
    await page.locator('[data-testid="theme-option-midnight"]').click();

    await expect.poll(() => isDark(page)).toBe(true);
    expect(await background(page)).toBe("#05050a");
    await expect(page.locator('[data-testid="theme-mode-system"]')).toBeDisabled();
    await expect(page.getByRole("button", { name: "Theme: Midnight" })).toBeDisabled();

    // Reload paints from the cache before the app fetches anything.
    await page.reload();
    expect(await isDark(page)).toBe(true);
    await page.context().close();
  });
});
