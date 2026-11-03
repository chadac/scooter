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
  sandboxTab: '[data-testid="right-panel-tab-session"]',
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  cancel: '[data-testid="interrupt-cancel"]',
};

test.describe("agent option dropdown (interrupt)", () => {
  // On the full target a fresh conversation provisions a real sandbox before its first run
  // event, and the answer steps retry the click with 60-90s windows.
  test.beforeEach(() => test.setTimeout(180_000));

  test("the agent presents options; picking one resumes the run", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");

    // The right panel appears, auto-focused to the Approvals tab, with the options.
    await expect(page.locator(panel.rightPanel)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.approvalsTab)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.option)).toHaveCount(3, { timeout: 30_000 });
    await expect(page.locator(panel.option).filter({ hasText: /green/i })).toHaveCount(1);

    // Pick "Green", re-clicking while the panel is up because a click made before it is
    // wired never reaches the agent.
    const green = page.locator(panel.option).filter({ hasText: /green/i });
    await expect(green).toBeEnabled({ timeout: 30_000 });
    await expect(async () => {
      if (await page.locator(panel.root).isVisible().catch(() => false)) {
        await green.click({ timeout: 5_000 }).catch(() => {});
      }
      await expect(page.getByText(/you picked: green/i).first()).toBeVisible({ timeout: 15_000 });
    }).toPass({ timeout: 90_000 });

    // The interrupt content goes away once answered; the right panel itself persists and
    // returns to the Session tab.
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(panel.rightPanel)).toBeVisible();
    await expect(page.locator(panel.sandboxTab)).toBeVisible();
  });

  test("dismissing the request cancels it", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");

    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    // Wait for the Dismiss button itself to be enabled, not merely the panel.
    const cancel = page.locator(panel.cancel);
    await expect(cancel).toBeEnabled({ timeout: 30_000 });
    await cancel.click();

    // The agent reports the cancellation and the interrupt content clears, re-clicking while
    // the panel is up because a click made before it is wired never reaches the agent.
    await expect(async () => {
      if (await page.locator(panel.root).isVisible().catch(() => false)) {
        await cancel.click({ timeout: 5_000 }).catch(() => {});
      }
      await expect(page.getByText(/you picked: \(cancelled\)/i).first()).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(panel.rightPanel)).toBeVisible();
    await expect(page.locator(panel.sandboxTab)).toBeVisible();
  });
});
