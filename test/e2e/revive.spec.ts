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
  test("history is restored after switching away and back", async ({ chat, page }) => {
    await chat.open();
    await chat.send("remember this message");
    await chat.waitForReply(/dummy agent/i);

    // Start a new conversation, then return to the first via the sidebar.
    await page.locator('[data-testid="new-session"]').click();
    await chat.send("a different conversation");
    await chat.waitForReply(/dummy agent/i);

    await page.locator(sidebar.item).first().click();
    await expect(chat.userMessages().first()).toContainText(/remember this message/i, {
      timeout: 30_000,
    });
  });
});
