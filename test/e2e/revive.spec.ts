/**
 * Tier 3 E2E — suspend from the UI, then revive with history + workspace intact.
 *
 * Exercises the full persistence story end to end through the browser. RED.
 */

import { test, expect } from "@playwright/test";

test("suspend then revive restores history and workspace", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /new conversation/i }).click();
  await page.getByRole("textbox", { name: /message/i }).fill("create a file foo.txt");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByTestId("assistant-message").last()).toBeVisible({ timeout: 30_000 });

  const url = page.url(); // capture thread URL

  // Suspend via the UI control.
  await page.getByRole("button", { name: /suspend/i }).click();
  await expect(page.getByText(/suspended/i)).toBeVisible();

  // Navigate away and back -> revive.
  await page.goto("/");
  await page.goto(url);

  // History replays (the earlier messages are present).
  await expect(page.getByTestId("assistant-message").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("user-message").first()).toContainText(/create a file/i);

  // Workspace still has the file (agent can read it back).
  await page.getByRole("textbox", { name: /message/i }).fill("cat foo.txt");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByTestId("tool-call-result").last()).toBeVisible({ timeout: 30_000 });
});
