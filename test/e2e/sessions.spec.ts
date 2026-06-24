/**
 * Tier 3 E2E — session selector + titles (left sidebar).
 *
 * The UI shows a list of conversations on the left; each has a title (the agent
 * assigns one). You can start a new conversation and switch between them.
 *
 * Uses the dummy-agent stack + the automatic no-error assertion.
 */

import { test, expect } from "./fixtures.js";

const sidebar = {
  list: '[data-testid="session-list"]',
  item: '[data-testid="session-item"]',
  newButton: '[data-testid="new-session"]',
  title: '[data-testid="session-title"]',
  deleteButton: '[data-testid="session-delete"]',
};

test.describe("session selector & titles", () => {
  test("a started conversation appears in the session list", async ({ chat, page }) => {
    await chat.open();
    await chat.send("hello there");
    await chat.waitForReply(/dummy agent/i);

    await expect(page.locator(sidebar.item)).toHaveCount(1, { timeout: 30_000 });
  });

  test("the agent assigns a title to the conversation", async ({ chat, page }) => {
    await chat.open();
    await chat.send("help me refactor the parser");
    await chat.waitForReply(/dummy agent/i);

    // Title should become non-empty (agent-assigned), not stay "New chat".
    const title = page.locator(sidebar.title).first();
    await expect(title).not.toHaveText("", { timeout: 30_000 });
    await expect(title).not.toHaveText(/new chat/i, { timeout: 30_000 });
  });

  test("new-session button starts a fresh conversation", async ({ chat, page }) => {
    await chat.open();
    await chat.send("first conversation");
    await chat.waitForReply(/dummy agent/i);

    await page.locator(sidebar.newButton).click();
    await chat.send("second conversation");
    await chat.waitForReply(/dummy agent/i);

    await expect(page.locator(sidebar.item)).toHaveCount(2, { timeout: 30_000 });
  });

  test("deleting a conversation removes it from the list", async ({ chat, page }) => {
    await chat.open();
    await chat.send("keep this one");
    await chat.waitForReply(/dummy agent/i);
    await page.locator(sidebar.newButton).click();
    await chat.send("delete this one");
    await chat.waitForReply(/dummy agent/i);
    await expect(page.locator(sidebar.item)).toHaveCount(2);

    // Delete the second (current) conversation.
    await page.locator(sidebar.item).first().locator(sidebar.deleteButton).click();
    await expect(page.locator(sidebar.item)).toHaveCount(1, { timeout: 10_000 });
  });

  test("clicking a session swaps the thread (other conversation's messages go away)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("alpha conversation");
    await chat.waitForReply(/dummy agent/i);
    await page.locator(sidebar.newButton).click();
    await chat.send("beta conversation");
    await chat.waitForReply(/dummy agent/i);

    // While on beta, beta is shown and alpha is NOT (a broken swap leaves the
    // old thread's messages on screen).
    await expect(chat.userMessages().filter({ hasText: /beta conversation/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages().filter({ hasText: /alpha conversation/i })).toHaveCount(0);

    // Switch back to alpha; now alpha is shown and beta is gone.
    await page.locator(sidebar.item).filter({ hasText: /alpha conversation/i }).first().click();
    await expect(chat.userMessages().filter({ hasText: /alpha conversation/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages().filter({ hasText: /beta conversation/i })).toHaveCount(0);
  });

  test("deleting the current conversation actually changes the thread view (not a no-op)", async ({
    chat,
    page,
  }) => {
    await chat.open();
    await chat.send("first survivor");
    await chat.waitForReply(/dummy agent/i);
    await page.locator(sidebar.newButton).click();
    await chat.send("doomed conversation");
    await chat.waitForReply(/dummy agent/i);
    await expect(page.locator(sidebar.item)).toHaveCount(2);

    // The current (doomed) conversation's message is on screen.
    await expect(chat.userMessages().filter({ hasText: /doomed conversation/i })).toHaveCount(1);

    // Delete the CURRENT conversation. deleteSession selects a remaining one,
    // so the view must swap to the survivor — the doomed message must vanish
    // and the survivor's message must appear (the "close is a no-op" bug).
    await page
      .locator(sidebar.item)
      .filter({ hasText: /doomed/i })
      .first()
      .locator(sidebar.deleteButton)
      .click();

    await expect(page.locator(sidebar.item)).toHaveCount(1, { timeout: 10_000 });
    await expect(chat.userMessages().filter({ hasText: /doomed conversation/i })).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(chat.userMessages().filter({ hasText: /first survivor/i })).toHaveCount(1, {
      timeout: 30_000,
    });
  });
});
