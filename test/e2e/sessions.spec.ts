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

  test("send -> swap conversation -> send again preserves each conversation's messages", async ({
    chat,
    page,
  }) => {
    // Distinct, non-overlapping message texts so substring (`hasText`) matchers
    // are unambiguous (e.g. "alpha-one" is not a substring of "alpha-two").
    await chat.open();
    // Conversation A.
    await chat.send("alpha-one");
    await chat.waitForReply(/dummy agent/i);
    // New conversation B, send there.
    await page.locator(sidebar.newButton).click();
    await chat.send("bravo-one");
    await chat.waitForReply(/dummy agent/i);
    await expect(page.locator(sidebar.item)).toHaveCount(2);

    // Back to A: its message must still be there (the reported resume bug —
    // sending in B must not lose A's messages).
    await page.locator(sidebar.item).filter({ hasText: /alpha-one/i }).first().click();
    await expect(chat.userMessages().filter({ hasText: /alpha-one/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages().filter({ hasText: /bravo-/i })).toHaveCount(0);

    // Send a SECOND message in A; both A messages present, B's still absent.
    await chat.send("alpha-two");
    await chat.waitForReply(/dummy agent/i);
    await expect(chat.userMessages().filter({ hasText: /alpha-one/i })).toHaveCount(1);
    await expect(chat.userMessages().filter({ hasText: /alpha-two/i })).toHaveCount(1);
    await expect(chat.userMessages().filter({ hasText: /bravo-/i })).toHaveCount(0);

    // And B still has only its own message when we switch back.
    await page.locator(sidebar.item).filter({ hasText: /bravo-one/i }).first().click();
    await expect(chat.userMessages().filter({ hasText: /bravo-one/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages().filter({ hasText: /alpha-/i })).toHaveCount(0);
  });

  test("conversations survive a page refresh (loaded from the server)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("persisted conversation one");
    await chat.waitForReply(/dummy agent/i);
    await page.locator(sidebar.newButton).click();
    await chat.send("persisted conversation two");
    await chat.waitForReply(/dummy agent/i);
    await expect(page.locator(sidebar.item)).toHaveCount(2);

    // Refresh: the sidebar must repopulate from the server (not reset to one
    // fresh in-memory session), so all conversations remain available.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(sidebar.item)).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator(sidebar.title).filter({ hasText: /persisted conversation one/i })).toHaveCount(1);
    await expect(page.locator(sidebar.title).filter({ hasText: /persisted conversation two/i })).toHaveCount(1);
  });

  test("a FRESH first visit is populated with the server's existing sessions", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    // Seed conversations on the SERVER directly (no UI), as if a previous
    // user/session had created them. The server (agent-host) is the source of
    // truth; a brand-new browser visit must show them.
    const base = baseURL ?? "http://localhost:5173";
    const r1 = await request.post(`${base}/conversations`, {
      data: { threadId: `seeded-one-${Date.now()}`, title: "Seeded session one" },
    });
    const r2 = await request.post(`${base}/conversations`, {
      data: { threadId: `seeded-two-${Date.now()}`, title: "Seeded session two" },
    });
    expect(r1.ok() && r2.ok(), "seeding /conversations failed").toBeTruthy();

    // First visit with NO carried-over local state — a fresh page load.
    await chat.open();

    // The sidebar must be populated from the server on first visit.
    await expect(page.locator(sidebar.title).filter({ hasText: /Seeded session one/i })).toHaveCount(
      1,
      { timeout: 30_000 },
    );
    await expect(page.locator(sidebar.title).filter({ hasText: /Seeded session two/i })).toHaveCount(
      1,
    );
  });
});
