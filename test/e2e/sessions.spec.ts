/**
 * Tier 3 E2E — session history / list views.
 *
 * Proves the "view existing sessions and their logs" requirement. RED.
 */

import { test, expect } from "@playwright/test";

test.describe("sessions list & history", () => {
  test("created conversations appear in the sessions list", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /new conversation/i }).click();
    await page.getByRole("textbox", { name: /message/i }).fill("hello");
    await page.getByRole("button", { name: /send/i }).click();
    await expect(page.getByTestId("assistant-message").last()).toBeVisible({ timeout: 30_000 });

    await page.getByRole("link", { name: /sessions/i }).click();
    await expect(page.getByTestId("session-list-item")).toHaveCount(1);
  });

  test("opening a past session replays its event log", async ({ page }) => {
    await page.goto("/sessions");
    await page.getByTestId("session-list-item").first().click();

    await expect(page.getByTestId("user-message").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("assistant-message").first()).toBeVisible();
  });

  test("session list shows status (running / suspended / ended)", async ({ page }) => {
    await page.goto("/sessions");
    await expect(page.getByTestId("session-status").first()).toHaveText(/running|suspended|ended/i);
  });
});
