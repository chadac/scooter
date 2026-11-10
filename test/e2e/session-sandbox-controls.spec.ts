/**
 * The Session tab's sandbox controls: resources, the size picker, the update banner, and
 * restart and stop. The fake stack has no provisioner, so the routes are stubbed here; the
 * test catches the panel losing its data loading or handlers.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const SIZES = {
  sizes: { small: { cpu: "1", memory: "2Gi" }, large: { cpu: "4", memory: "8Gi", gpu: 1, hint: "For builds" } },
  default: "small",
};
const SMALL = { cpu: "1", memory: "2Gi" };

/** Stubs the sandbox routes; returns the requests the UI sends. */
async function stubSandbox(page: Page) {
  const sent: string[] = [];
  await page.route("**/sandbox-sizes", (route) => route.fulfill(json(SIZES)));
  await page.route("**/conversations/*/resources", (route) =>
    route.fulfill(json({ resources: { requests: SMALL, limits: SMALL }, pendingRestart: { image: true } })),
  );
  await page.route("**/conversations/*/size", (route) => {
    sent.push(`size ${route.request().postDataJSON().size}`);
    return route.fulfill(json({}));
  });
  for (const action of ["restart", "suspend"]) {
    await page.route(`**/conversations/*/${action}`, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sent.push(action);
      return route.fulfill(json({}));
    });
  }
  return sent;
}

test("the Session tab shows resources, the size picker, and restart and stop", async ({ chat, page }) => {
  const sent = await stubSandbox(page);
  await chat.open();
  await chat.sendTurn("!echo session controls");
  await page.locator('[data-testid="right-panel-tab-session"]').click();
  await expect(page.locator('[data-testid="sandbox-state"]')).toHaveAttribute("data-state", "running", {
    timeout: 60_000,
  });

  await expect(page.locator('[data-testid="sandbox-resources-limits"]')).toHaveText("1 CPU · 2Gi");
  await expect(page.locator('[data-testid="sandbox-update-banner"]')).toContainText("Update available");
  await page.locator('[data-testid="sandbox-update-hint"]').hover();
  await expect(page.getByRole("tooltip")).toContainText("A restart picks up");
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  const select = page.locator('[data-testid="sandbox-size-select"]');
  await expect(select).toHaveValue("small");
  await select.selectOption("large");
  await expect(page.locator('[data-testid="sandbox-size-pending"]')).toBeVisible();
  await expect(page.locator('[data-testid="sandbox-resources-limits"]')).toHaveText("4 CPU · 8Gi · 1 GPU");
  await page.locator('[data-testid="sandbox-size-hint"]').hover();
  await expect(page.getByRole("tooltip")).toContainText("For builds");

  await page.locator('[data-testid="sandbox-restart"]').click();
  await expect.poll(() => sent.includes("restart")).toBe(true);
  await page.locator('[data-testid="sandbox-stop"]').click();
  await expect.poll(() => sent).toEqual(["size large", "restart", "suspend"]);
});
