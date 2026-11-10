/**
 * The Services panel's Add service dialog: its answers reach the conversation as a request
 * to Scooter. The fake stack has no sandbox to declare the service in, so the test stops
 * at the sent message.
 */

import { test, expect } from "./fixtures.js";

test("the Add service dialog sends Scooter a request to build the service", async ({ chat, page }) => {
  await chat.open();
  await chat.sendTurn("!echo add service");
  await page.locator('[data-testid="right-panel-tab-session"]').click();
  await page.locator('[data-testid="service-add"]').click({ timeout: 60_000 });

  const dialog = page.locator('[data-testid="add-service-dialog"]');
  await expect(dialog).toBeVisible();
  const submit = dialog.locator('[data-testid="add-service-submit"]');
  await expect(submit).toBeDisabled();

  await dialog.locator('[data-testid="add-service-name"]').fill("Bad Name");
  await expect(dialog.locator('[data-testid="add-service-error"]')).toContainText("lowercase");
  await dialog.locator('[data-testid="add-service-name"]').fill("dashboard");
  await dialog.locator('[data-testid="add-service-description"]').fill("A Streamlit dashboard for app.py");
  await submit.click();

  await expect(dialog).toBeHidden();
  await expect(
    page.locator(".aui-user-message-content").filter({ hasText: "webServices.dashboard" }),
  ).toBeVisible({ timeout: 15_000 });
});
