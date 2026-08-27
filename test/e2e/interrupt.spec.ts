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
  sandboxTab: '[data-testid="right-panel-tab-sandbox"]',
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  cancel: '[data-testid="interrupt-cancel"]',
};

test.describe("agent option dropdown (interrupt)", () => {
  // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). On the full target a fresh
  // conversation provisions a REAL sandbox before its first run event lands
  // (~15-25s cold, per the instrumented stop-run runs), so each phase's 30s wait
  // is fine but their SUM is not: open (~20s) + panel (~30s incl. provisioning) +
  // pick → reply (~30s) + panel-clear (~10s) ≈ 90s worst case, past the 60s
  // default while every step behaves. Assertions unchanged; only the ceiling.
  //
  // 180s, not 120: the answer steps now RETRY the click (a click made before the panel is
  // wired never reaches the agent and cannot be waited out), and their retry windows are
  // 60-90s. Summed with the 30s panel wait that precedes them, 120s left no headroom.
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

    // Pick "Green" -> the run resumes and the agent reports the choice.
    // RETRY, for the same reason the Dismiss below does: the panel is visible as soon as the
    // interrupt renders, but a click made before it is wired resolves to the element and
    // never reaches the agent. CI failed here with "you picked: green" absent for the full
    // 30s. A click that did nothing cannot be waited out, so re-click while the panel is up.
    const green = page.locator(panel.option).filter({ hasText: /green/i });
    await expect(green).toBeEnabled({ timeout: 30_000 });
    await expect(async () => {
      if (await page.locator(panel.root).isVisible().catch(() => false)) {
        await green.click({ timeout: 5_000 }).catch(() => {});
      }
      await expect(page.getByText(/you picked: green/i).first()).toBeVisible({ timeout: 15_000 });
    }).toPass({ timeout: 90_000 });

    // The interrupt content goes away once the request is answered. The right panel
    // itself PERSISTS now (the Sandbox status tab is always present for a live
    // conversation) — it no longer collapses, and it auto-returns to the Sandbox tab.
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(panel.rightPanel)).toBeVisible();
    await expect(page.locator(panel.sandboxTab)).toBeVisible();
  });

  test("dismissing the request cancels it", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");

    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    // Wait for the Dismiss button itself, not merely the panel. The panel becomes visible
    // as soon as the interrupt renders, but the button is only useful once it is attached
    // and enabled — the sibling "pick Green" test gets this settling time for free from the
    // toHaveCount(1) option assertion it makes first, and this test had no equivalent.
    const cancel = page.locator(panel.cancel);
    await expect(cancel).toBeEnabled({ timeout: 30_000 });
    await cancel.click();

    // The agent reports the cancellation and the interrupt content clears. The right
    // panel persists (the Sandbox status tab is always present for a live conversation).
    //
    // RETRY the dismiss. On CI this failed with the panel completely untouched — still
    // "Approvals 1" with Red/Green/Blue/Dismiss all present after the full 30s — i.e. the
    // click resolved to the element but the answer never reached the agent. A single click
    // that silently does nothing is indistinguishable from a broken cancel, so re-click
    // while the panel is still up rather than waiting out a click that never landed. If
    // cancel is genuinely broken the panel stays and this still fails.
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
