/**
 * Tier 3 E2E — interrupts coexisting with a QUEUE, and recovery back to a clean state.
 *
 * Targets the "weird detached state" family where an approval interrupt + queued messages + run
 * state get out of sync. An interrupt PAUSES the run awaiting a human answer; messages sent during
 * that pause must queue (and be visible), and answering the interrupt must let the queue proceed and
 * return the UI to a clean, sendable state.
 *
 * Uses the fake agent's `?pick a color` (a permission interrupt) + `!sleep` (a long run).
 */

import { test, expect } from "./fixtures.js";

const panel = {
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  cancel: '[data-testid="interrupt-cancel"]',
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
  approvalsBadge: '[data-testid="right-panel-badge-approvals"]',
  queueTab: '[data-testid="right-panel-tab-queue"]',
};

// CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). On the full target a fresh
// conversation provisions a REAL sandbox before its first run event (~15-25s cold,
// per the instrumented stop-run runs), and these tests chain several phases each
// funded with its own 15-30s wait: open (~20s) + panel (~30s incl. provisioning) +
// queue/answer (~15-30s) + drain + the queued/follow-up turn (~30-45s) ≈ 120-160s
// worst case — past the 60s default on arithmetic alone while every step behaves.
// Assertions unchanged; only the ceiling.
const CLUSTER_BUDGET_MS = 180_000;

test.describe("interrupt + queue coexistence", () => {
  test.beforeEach(() => test.setTimeout(CLUSTER_BUDGET_MS));

  test("messages QUEUE while an approval interrupt is pending (both surfaces populated)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 }); // run paused on the interrupt

    // The run is paused awaiting the pick → a message sent now must queue.
    await chat.sendWhileRunning("queued behind the approval");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="queued-message-text"]').first()).toContainText("queued behind the approval");
  });

  test("answering the interrupt lets the QUEUE drain (the queued message then runs)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await chat.sendWhileRunning("run after I approve");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });

    // Switch BACK to the Approvals tab (openQueueTab moved us to Queue) so the interrupt options are
    // visible, then answer → the paused run resumes, then the queued message runs.
    await page.locator(panel.approvalsTab).click();
    await page.locator(panel.option).filter({ hasText: /green/i }).click();
    await expect(page.getByText(/you picked: green/i).first()).toBeVisible({ timeout: 30_000 });
    // The queue drains + the queued message becomes a real user turn.
    await expect(chat.queuedMessages()).toHaveCount(0, { timeout: 30_000 });
    await expect(chat.userMessages().filter({ hasText: "run after I approve" })).toHaveCount(1, { timeout: 30_000 });
  });

  test("the interrupt panel + queue tab are BOTH reachable (badges reflect their counts)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    // The approvals badge shows a pending count.
    await expect(page.locator(panel.approvalsBadge)).toBeVisible({ timeout: 15_000 });
    await chat.sendWhileRunning("q1");
    await chat.sendWhileRunning("q2");
    // The queue tab badge counts the queued items independently of the interrupt.
    await expect(page.locator('[data-testid="right-panel-badge-queue"]')).toHaveText(/2/, { timeout: 15_000 });
  });
});

test.describe("interrupt persistence + recovery", () => {
  test.beforeEach(() => test.setTimeout(CLUSTER_BUDGET_MS)); // same arithmetic as above

  test("a pending approval SURVIVES a reload (the panel reappears)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

    await page.reload();
    // The interrupt is persisted on the integrity log → the panel re-derives after the reload.
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.option)).toHaveCount(3, { timeout: 30_000 });
    // And it's still answerable after the reload.
    await page.locator(panel.option).filter({ hasText: /red/i }).click();
    await expect(page.getByText(/you picked: red/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test("after answering, the UI returns to a CLEAN sendable state (no stuck panel / working)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await page.locator(panel.option).filter({ hasText: /blue/i }).click();
    await expect(page.getByText(/you picked: blue/i).first()).toBeVisible({ timeout: 30_000 });

    // Clean state: the interrupt panel is gone, no stuck run-status bar, and a new turn works first-try.
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: 15_000 });
    await chat.sendTurn("a normal turn after the interrupt");
    await expect(chat.userMessages().filter({ hasText: "a normal turn after the interrupt" })).toHaveCount(1);
  });

  test("a dismissed (cancelled) interrupt also returns to a clean state", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await page.locator(panel.cancel).click();
    await expect(page.getByText(/you picked: \(cancelled\)/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    await chat.sendTurn("works after a cancel");
    await expect(chat.userMessages().filter({ hasText: "works after a cancel" })).toHaveCount(1);
  });
});
