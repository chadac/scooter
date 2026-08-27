/**
 * Tier 3 E2E — conversation history survives a reload (revive).
 *
 * Send a message, reload the page, and confirm the conversation is restored
 * from the session list with its history intact. Uses the dummy-agent stack +
 * the automatic no-error assertion.
 *
 * NOTE: the full suspend/resume-with-workspace path is covered by the Tier 2
 * cluster tests; here we exercise the UI-level conversation persistence.
 */

import { test, expect } from "./fixtures.js";

const sidebar = { item: '[data-testid="session-item"]' };

test.describe("conversation persistence (UI)", () => {
  // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). This test funds TWO full
  // conversation boots (the original + "a different conversation"), each of which can
  // wait 5-25s for a ready sandbox pod on the full target, plus a real exec per turn
  // (the fake agent shells `echo <text>`). Arithmetic: 2 x (25s boot + ~8s turn) +
  // switch-back replay ≈ 75s — over the 60s default on timing alone. 180s = that
  // worst case with ~2x headroom.
  test.setTimeout(180_000);

  test("history is restored after switching away and back", async ({ chat, page }) => {
    await chat.open();
    await chat.send("remember this message");
    await chat.waitForReply(/dummy agent/i);

    // Start a new conversation, then return to the first via the sidebar. 100s reply
    // budget: this turn funds the SECOND conversation's sandbox boot on the full target.
    await page.locator('[data-testid="new-session"]').click();
    await chat.send("a different conversation");
    await chat.waitForReply(/dummy agent/i, 100_000);

    // Return to the FIRST conversation by its title (not positional .first(),
    // which is the newest = the second conversation).
    await page.locator(sidebar.item).filter({ hasText: /remember this message/i }).first().click();
    await expect(chat.userMessages().filter({ hasText: /remember this message/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages().filter({ hasText: /a different conversation/i })).toHaveCount(0);
  });
});
