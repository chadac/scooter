/**
 * Tier 3 E2E for the session selector and titles in the left sidebar: conversations are
 * listed with agent-assigned titles, and the user can start a new one and switch between
 * them. Uses the dummy-agent stack and the automatic no-error assertion.
 */

import { test, expect } from "./fixtures.js";
import { fastOnly } from "./target.js";

const sidebar = {
  list: '[data-testid="session-list"]',
  item: '[data-testid="session-item"]',
  newButton: '[data-testid="new-session"]',
  title: '[data-testid="session-title"]',
};

/** The current conversation's star / move / rename / delete, beside its title in the header. */
const header = {
  deleteButton: '[data-testid="header-conversation"] [data-testid="session-delete"]',
  starButton: '[data-testid="header-conversation"] [data-testid="session-star"]',
  renameButton: '[data-testid="header-conversation"] [data-testid="session-rename"]',
  moveButton: '[data-testid="header-conversation"] [data-testid="session-move"]',
  renameInput: '[data-testid="header-conversation"] [data-testid="session-rename-input"]',
};

/** Sidebar sections: Starred and the user's folders, then Recent. */
const folders = {
  section: (id: string) => `[data-testid="folder-section"][data-folder-id="${id}"]`,
  header: '[data-testid="folder-header"]',
  recent: '[data-testid="recent-section"]',
};

/** The open conversation's title in the top header, which mirrors the tab title. */
const headerTitle = '[data-testid="header-conversation-title"]';

test.describe("session selector & titles", () => {
  // Most tests here run two conversations, which on the full target is two sandbox boots.
  test.setTimeout(180_000);

  test("a started conversation appears in the session list", async ({ chat, page }) => {
    await chat.open();
    await chat.send("hello there");
    await chat.waitForReply(/dummy agent/i);

    // This conversation's row is listed; not an absolute length, since the full target's
    // fleet is shared.
    await expect(
      page.locator(sidebar.item).filter({ hasText: /hello there/i }),
    ).toHaveCount(1, { timeout: 30_000 });
  });

  test("the agent assigns a title to the conversation", async ({ chat, page }) => {
    await chat.open();
    await chat.send("help me refactor the parser");
    await chat.waitForReply(/dummy agent/i);

    // The agent titles the conversation via a <title> marker extracted server-side, and the
    // sidebar reflects it within the merge poll.
    const title = page.locator(sidebar.title).first();
    await expect(title).not.toHaveText(/new chat/i, { timeout: 30_000 });
    await expect(title).toHaveText(/refactor the parser/i, { timeout: 30_000 });
    // The raw marker must never leak into the displayed title or the chat body.
    await expect(title).not.toHaveText(/<title>/i);
    await expect(chat.assistantMessages().filter({ hasText: /<title>/i })).toHaveCount(0);
  });

  // STILL QUARANTINED, and no longer for the reason #742 recorded. Enabled on the full
  // target, this failed 1 of 5 repetitions on the self-hosted fleet against a real cluster
  // (run 38921656329), so "a timing artifact of the undersized 2-core runner" is not the
  // whole story: the trace shows the click landing on ✎, and no editing render in the 15s
  // that follow — openRename() can silently no-op under load on any runner. That is a UI
  // bug (#796), not a test bug, and re-enabling here would only make it CI's problem.
  // services/ui/src/HeaderConversationTitle.rename.test.ts guards the blur rule meanwhile. Rename now
  // lives in the header, away from the remounting sidebar row, so this may be re-enableable.
  test.skip("the user can rename a conversation, and the agent can't override it", async ({ chat, page }) => {
    await chat.open();
    await chat.send("help me refactor the parser");
    await chat.waitForReply(/dummy agent/i);
    // Keyed by conversation id, not .first(): the full target's fleet is shared, and a
    // hasText filter would stop matching once the rename swaps the title span for an input.
    const titled = page.locator(sidebar.item).filter({ hasText: /refactor the parser/i });
    await expect(titled).toHaveCount(1, { timeout: 30_000 });
    const convId = await titled.getAttribute("data-conversation-id");
    expect(convId).toBeTruthy();
    const row = page.locator(`${sidebar.item}[data-conversation-id="${convId}"]`);
    const title = row.locator(sidebar.title);
    await expect(title).toHaveText(/refactor the parser/i, { timeout: 30_000 });

    // Open the rename input, type a name, Enter to commit.
    await page.locator(header.renameButton).click();
    const input = page.locator(header.renameInput);
    await expect(input).toBeVisible();
    await input.fill("My pinned project");
    await input.press("Enter");
    await expect(title).toHaveText(/my pinned project/i, { timeout: 10_000 });

    // The agent titling again on a follow-up turn must not override the user's name.
    await chat.send("now do the other thing");
    await chat.waitForReply(/dummy agent/i);
    // Give the stream's upsert a chance to (wrongly) clobber it, then assert it held.
    await expect(title).toHaveText(/my pinned project/i, { timeout: 30_000 });
    await expect(title).not.toHaveText(/refactor/i);
  });

  test("the tab title and the header carry the conversation's title", async ({ chat, page }) => {
    await chat.open();
    // An unnamed conversation is the bare wordmark, with no header title beside it.
    await expect(page).toHaveTitle("scooter");
    await expect(page.locator(headerTitle)).toHaveCount(0);

    await chat.send("help me refactor the parser");
    await chat.waitForReply(/dummy agent/i);

    await expect(page.locator(headerTitle)).toHaveText(/refactor the parser/i, { timeout: 30_000 });
    await expect(page).toHaveTitle(/^scooter - .*refactor the parser/i, { timeout: 30_000 });
  });

  test("a bare URL opens a NEW conversation, while ?thread= still restores one", async ({ chat, page }) => {
    await chat.open();
    await chat.send("earlier conversation marker");
    await chat.waitForReply(/dummy agent/i);

    // A reload keeps ?thread=, so it restores the conversation it was showing.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await expect(chat.userMessages().filter({ hasText: /earlier conversation marker/i })).toHaveCount(
      1,
      { timeout: 30_000 },
    );

    // The bare root opens an empty conversation, not the last one.
    await page.goto("/");
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator(sidebar.item).filter({ hasText: /earlier conversation marker/i }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(chat.userMessages()).toHaveCount(0);
    await expect(page).toHaveTitle("scooter");
  });

  test("the user can star and unstar a conversation", async ({ chat, page }) => {
    await chat.open();
    await chat.send("something worth keeping");
    await chat.waitForReply(/dummy agent/i);

    const row = page.locator(sidebar.item).first();
    const star = page.locator(header.starButton);
    await expect(row).not.toHaveAttribute("data-starred", "true");
    await star.click();
    await expect(row).toHaveAttribute("data-starred", "true", { timeout: 10_000 });
    await star.click();
    await expect(row).not.toHaveAttribute("data-starred", "true", { timeout: 10_000 });
  });

  test("starring files a conversation in Starred, and it stays there after a reload", async ({ chat, page }) => {
    await chat.open();
    await chat.send("pin me to the top");
    await chat.waitForReply(/dummy agent/i);

    const starred = page.locator(folders.section("starred")).locator(sidebar.item).filter({ hasText: /pin me to the top/i });
    await expect(starred).toHaveCount(0);
    await page.locator(header.starButton).click();
    await expect(starred).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(folders.recent).locator(sidebar.item).filter({ hasText: /pin me to the top/i })).toHaveCount(0);

    // Folders are server state, so the star survives a reload.
    await page.reload();
    await expect(starred).toHaveCount(1, { timeout: 30_000 });
    await page.locator(header.starButton).click();
    await expect(starred).toHaveCount(0, { timeout: 10_000 });
  });

  test("Move to… files a conversation in a new folder, and deleting the folder returns it to Recent", async ({ chat, page }) => {
    await chat.open();
    await chat.send("file me away");
    await chat.waitForReply(/dummy agent/i);
    const name = `e2e-folder-${Date.now()}`;

    await page.locator(header.moveButton).click();
    await page.getByRole("textbox", { name: "Filter folders" }).fill(name);
    await page.keyboard.press("Enter");

    const folderHeader = page.locator(folders.header).filter({ hasText: name });
    await expect(folderHeader).toHaveCount(1, { timeout: 10_000 });
    const folderId = await folderHeader.getAttribute("data-folder-id");
    const filed = page.locator(folders.section(folderId!)).locator(sidebar.item).filter({ hasText: /file me away/i });
    await expect(filed).toHaveCount(1, { timeout: 10_000 });

    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: `${name} folder actions` }).click();
    await page.getByRole("menuitem", { name: "Delete folder" }).click();
    await expect(folderHeader).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(folders.recent).locator(sidebar.item).filter({ hasText: /file me away/i })).toHaveCount(1);
  });

  test("new-session button starts a fresh conversation", async ({ chat, page }) => {
    await chat.open();
    await chat.send("first conversation");
    await chat.waitForReply(/dummy agent/i);

    await page.locator(sidebar.newButton).click();
    await chat.send("second conversation");
    await chat.waitForReply(/dummy agent/i);

    // Both of this test's conversations are listed as separate rows, pinned by their own
    // text rather than an absolute count.
    await expect(
      page.locator(sidebar.item).filter({ hasText: /first conversation/i }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      page.locator(sidebar.item).filter({ hasText: /second conversation/i }),
    ).toHaveCount(1, { timeout: 30_000 });
  });

  test("deleting a conversation removes it from the list", async ({ chat, page, request, baseURL }) => {
    await chat.open();
    await chat.send("keep this one");
    await chat.waitForReply(/dummy agent/i);
    await page.locator(sidebar.newButton).click();
    await chat.send("delete this one");
    await chat.waitForReply(/dummy agent/i);

    // Assert on this test's own rows, not an absolute list length, since the full target's
    // fleet is shared.
    const keepRow = page.locator(sidebar.item).filter({ hasText: /keep this one/i });
    const deleteRow = page.locator(sidebar.item).filter({ hasText: /delete this one/i });
    await expect(keepRow).toHaveCount(1, { timeout: 30_000 });
    await expect(deleteRow).toHaveCount(1, { timeout: 30_000 });

    // The row's disappearance is optimistic, so capture the server id first and check the
    // deletion actually landed.
    const deletedId = await deleteRow.first().getAttribute("data-conversation-id");
    expect(deletedId, "the row must carry the server id before we delete it").toBeTruthy();

    // Delete shows a confirm dialog; accept it.
    page.on("dialog", (d) => d.accept());
    // It is the open conversation, so the header delete acts on it.
    await page.locator(header.deleteButton).click();
    // On the full target the DELETE also tears down the sandbox pod before the row clears.
    await expect(deleteRow).toHaveCount(0, { timeout: 30_000 });
    // The other conversation is untouched.
    await expect(keepRow).toHaveCount(1);
    // The server agrees it is gone.
    await expect
      .poll(
        async () =>
          (
            await request.get(`${baseURL ?? "http://localhost:5173"}/conversations/${deletedId}`)
          ).status(),
        { timeout: 30_000 },
      )
      .toBe(404);
  });

  test("clicking a session swaps the thread (other conversation's messages go away)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("alpha conversation");
    await chat.waitForReply(/dummy agent/i);
    await page.locator(sidebar.newButton).click();
    await chat.send("beta conversation");
    await chat.waitForReply(/dummy agent/i);

    // While on beta, beta is shown and alpha is not.
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
    // This test's own two rows (not an absolute length — the fleet is shared).
    await expect(
      page.locator(sidebar.item).filter({ hasText: /first survivor/i }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      page.locator(sidebar.item).filter({ hasText: /doomed/i }),
    ).toHaveCount(1, { timeout: 30_000 });

    // The current (doomed) conversation's message is on screen.
    await expect(chat.userMessages().filter({ hasText: /doomed conversation/i })).toHaveCount(1);

    // Deleting the current conversation selects a survivor, so the view must swap to it.
    page.on("dialog", (d) => d.accept()); // accept the delete confirm
    await page.locator(header.deleteButton).click();

    // On the full target the DELETE also tears down the sandbox pod; assert the doomed row
    // went away and the survivor stayed, not a fleet-wide count.
    await expect(page.locator(sidebar.item).filter({ hasText: /doomed/i })).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(page.locator(sidebar.item).filter({ hasText: /first survivor/i })).toHaveCount(1, {
      timeout: 30_000,
    });
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
    // Distinct, non-overlapping message texts so `hasText` matchers are unambiguous.
    await chat.open();
    // Conversation A.
    await chat.send("alpha-one");
    await chat.waitForReply(/dummy agent/i);
    // New conversation B, send there.
    await page.locator(sidebar.newButton).click();
    await chat.send("bravo-one");
    await chat.waitForReply(/dummy agent/i);
    // This test's own two rows (not an absolute length — the fleet is shared).
    await expect(page.locator(sidebar.item).filter({ hasText: /alpha-one/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(page.locator(sidebar.item).filter({ hasText: /bravo-one/i })).toHaveCount(1, {
      timeout: 30_000,
    });

    // Back to A: its message must still be there.
    await page.locator(sidebar.item).filter({ hasText: /alpha-one/i }).first().click();
    await expect(chat.userMessages().filter({ hasText: /alpha-one/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages().filter({ hasText: /bravo-/i })).toHaveCount(0);

    // Send a second message in A; both A messages present, B's still absent.
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
    // This test's own two rows (not an absolute length — the fleet is shared).
    const one = page.locator(sidebar.item).filter({ hasText: /persisted conversation one/i });
    const two = page.locator(sidebar.item).filter({ hasText: /persisted conversation two/i });
    await expect(one).toHaveCount(1, { timeout: 30_000 });
    await expect(two).toHaveCount(1, { timeout: 30_000 });

    // After a refresh the sidebar must repopulate from the server.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await expect(one).toHaveCount(1, { timeout: 30_000 });
    await expect(two).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(sidebar.title).filter({ hasText: /persisted conversation one/i })).toHaveCount(1);
    await expect(page.locator(sidebar.title).filter({ hasText: /persisted conversation two/i })).toHaveCount(1);
  });

});

// Fast only: an API-seeded conversation with no run has no assignment yet, so the full
// target's multi-pod aggregate does not reliably serve it.
fastOnly("an API-seeded conversation with no run is not served by the multi-pod aggregate")(
  "session selector & titles — fresh first visit",
  () => {
  test("a FRESH first visit is populated with the server's existing sessions", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    // Seed conversations on the server directly, as if a previous session had created them.
    const base = baseURL ?? "http://localhost:5173";
    const r1 = await request.post(`${base}/conversations`, {
      data: { title: "Seeded session one" },
    });
    const r2 = await request.post(`${base}/conversations`, {
      data: { title: "Seeded session two" },
    });
    expect(r1.ok() && r2.ok(), "seeding /conversations failed").toBeTruthy();

    // Confirm the server retained both seeds before loading the page, so a failure below is
    // about the sidebar.
    await expect
      .poll(
        async () => {
          const res = await request.get(`${base}/conversations`);
          if (!res.ok()) return 0;
          const rows = (await res.json()) as Array<{ title?: string }>;
          return rows.filter((c) => /Seeded session (one|two)/i.test(c.title ?? "")).length;
        },
        { timeout: 20_000 },
      )
      .toBe(2);

    // First visit with no carried-over local state.
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
  },
);
