/**
 * Tier 3 E2E — agent-presented option dropdown (AG-UI interrupt).
 *
 * The agent pauses the run with an interrupt carrying a set of options; the UI
 * renders them as inline buttons in the right-side panel's Approvals tab (the
 * RightPanel, auto-focused to Approvals on a new interrupt) and resumes the run with
 * the user's pick. Drives the fake agent's "?<prompt>" directive, which presents
 * Red/Green/Blue and reports the chosen one.
 */

import { test, expect } from "./fixtures.js";

const panel = {
  rightPanel: '[data-testid="right-panel"]',
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  cancel: '[data-testid="interrupt-cancel"]',
};

test.describe("agent option dropdown (interrupt)", () => {
  test("the agent presents options; picking one resumes the run", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");

    // The right panel appears, auto-focused to the Approvals tab, with the options.
    await expect(page.locator(panel.rightPanel)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.approvalsTab)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.option)).toHaveCount(3, { timeout: 30_000 });
    await expect(page.locator(panel.option).filter({ hasText: /green/i })).toHaveCount(1);

    // Pick "Green" -> the run resumes and the agent reports the choice.
    await page.locator(panel.option).filter({ hasText: /green/i }).click();
    await expect(page.getByText(/you picked: green/i).first()).toBeVisible({ timeout: 30_000 });

    // The approvals content — and (queue empty) the whole right panel — go away
    // once the request is answered.
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(panel.rightPanel)).toHaveCount(0, { timeout: 10_000 });
  });

  test("dismissing the request cancels it", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");

    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await page.locator(panel.cancel).click();

    // The agent reports the cancellation and the panel clears.
    await expect(page.getByText(/you picked: \(cancelled\)/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(panel.rightPanel)).toHaveCount(0, { timeout: 10_000 });
  });
});
