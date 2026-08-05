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
  starButton: '[data-testid="session-star"]',
  renameButton: '[data-testid="session-rename"]',
  renameInput: '[data-testid="session-rename-input"]',
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

    // The agent titles the conversation (via a <title> marker it emits first,
    // extracted server-side). The sidebar reflects it (within the merge poll).
    const title = page.locator(sidebar.title).first();
    await expect(title).not.toHaveText(/new chat/i, { timeout: 30_000 });
    await expect(title).toHaveText(/refactor the parser/i, { timeout: 30_000 });
    // The raw marker must never leak into the displayed title or the chat body.
    await expect(title).not.toHaveText(/<title>/i);
    await expect(chat.assistantMessages().filter({ hasText: /<title>/i })).toHaveCount(0);
  });

  test("the user can rename a conversation, and the agent can't override it", async ({ chat, page }) => {
    await chat.open();
    await chat.send("help me refactor the parser");
    await chat.waitForReply(/dummy agent/i);
    // Only one conversation here, so .first() is unambiguous. (Don't filter by title
    // text: opening the rename swaps the title span for an <input>, so a hasText filter
    // would stop matching the row the moment editing starts.)
    const row = page.locator(sidebar.item).first();
    const title = row.locator(sidebar.title);
    await expect(title).toHaveText(/refactor the parser/i, { timeout: 30_000 });

    // Open the rename input, type a name, Enter to commit. This is robust now that the
    // sidebar no longer re-renders unchanged rows on the merge poll (SessionRow is
    // memo'd + mergeFromServer reuses the object reference when nothing changed) AND
    // the input no longer closes on a spurious re-render blur (#230) — so a background
    // poll can't detach the input or swallow the open-rename click mid-interaction.
    await row.locator(sidebar.renameButton).click();
    const input = row.locator(sidebar.renameInput);
    await expect(input).toBeVisible();
    await input.fill("My pinned project");
    await input.press("Enter");
    await expect(title).toHaveText(/my pinned project/i, { timeout: 10_000 });

    // The agent titling again on a follow-up turn must NOT override the user's name.
    await chat.send("now do the other thing");
    await chat.waitForReply(/dummy agent/i);
    // Give the merge poll a chance to (wrongly) clobber it, then assert it held.
    await expect(title).toHaveText(/my pinned project/i, { timeout: 30_000 });
    await expect(title).not.toHaveText(/refactor/i);
  });

  test("the user can star and unstar a conversation", async ({ chat, page }) => {
    await chat.open();
    await chat.send("something worth keeping");
    await chat.waitForReply(/dummy agent/i);

    const row = page.locator(sidebar.item).first();
    const star = row.locator(sidebar.starButton);
    await expect(row).not.toHaveAttribute("data-starred", "true");
    await star.click();
    await expect(row).toHaveAttribute("data-starred", "true", { timeout: 10_000 });
    await star.click();
    await expect(row).not.toHaveAttribute("data-starred", "true", { timeout: 10_000 });
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

    // Delete now shows a confirm dialog (universal) — accept it.
    page.on("dialog", (d) => d.accept());
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
    page.on("dialog", (d) => d.accept()); // accept the universal delete confirm
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
