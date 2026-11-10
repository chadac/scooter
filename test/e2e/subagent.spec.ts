/**
 * Tier 3 E2E for subagent conversations. A subagent is a full conversation that shares its
 * parent's sandbox, and three rules define how it appears: nested under its parent as a
 * depth-1 row, shown by the parent in its Chats panel, and never
 * rendered as a top-level chat of its own. The fake agent's `~subagent` directive calls the
 * `spawn_subagent` MCP tool exactly as goose does, so the parent/child pair is real.
 */

import { test, expect, assertMatchesServer, shot } from "./fixtures.js";
import { fastOnly } from "./target.js";

/** The sidebar row for a subagent: nested rows mark themselves data-subagent. */
const SUBAGENT_ROW = '[data-testid="session-item"][data-subagent="true"]';
const TOP_LEVEL_ROW = '[data-testid="session-item"]:not([data-subagent="true"])';

fastOnly("the ~subagent directive is a fake-agent test hook")("subagent conversations", () => {
  test("a spawned subagent renders nested under its parent, never as an independent chat", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    await chat.open();

    // One top-level conversation before we start: the one we are typing into.
    await expect(page.locator(TOP_LEVEL_ROW)).toHaveCount(1);

    // The agent spawns a real subagent via the scooter-env MCP tool.
    await chat.completeTurn("~subagent investigate the broker timeout");

    // Rules 1 and 3: it appears as a nested row and the top-level count is unchanged.
    const nested = page.locator(SUBAGENT_ROW);
    await expect(nested, "the subagent must appear as a nested sidebar row").toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(
      page.locator(TOP_LEVEL_ROW),
      "a subagent must NOT add a top-level conversation row",
    ).toHaveCount(1);
    await expect(nested.locator('[data-testid="session-title"]')).toHaveText(
      "investigate the broker timeout",
    );

    // It is a real conversation: it carries a server id, distinct from its parent's.
    const subId = await nested.getAttribute("data-conversation-id");
    const parentId = await page.locator(TOP_LEVEL_ROW).getAttribute("data-conversation-id");
    expect(subId, "the subagent row must carry a server conversation id").toBeTruthy();
    expect(subId).not.toBe(parentId);

    // Rule 2: the parent shows it as a sub-conversation; the section only renders when
    // the parent can resolve its children.
    const section = page.locator('[data-testid="right-panel-section-chats"]');
    await expect(section, "the parent's Session tab must offer a Chats section").toBeVisible();
    await expect(section).toHaveAttribute("data-open", "true");
    const panelRows = page.locator('[data-testid="chat-row"][data-kind="subagent"]');
    await expect(panelRows).toHaveCount(1);
    await expect(panelRows.first()).toContainText("investigate the broker timeout");

    // The sidebar and the server agree about what exists.
    await assertMatchesServer(page, request, baseURL, "after spawning a subagent");
  });

  test("a subagent SURVIVES live upserts for other conversations", async ({ chat, page, request, baseURL }) => {
    // A live single-row upsert about another conversation must not evict the subagent row.
    await chat.open();
    await chat.completeTurn("~subagent watch the deploy");
    await expect(page.locator(SUBAGENT_ROW)).toHaveCount(1, { timeout: 30_000 });
    const parentId = await page.locator(TOP_LEVEL_ROW).first().getAttribute("data-conversation-id");
    expect(parentId).toBeTruthy();

    // Start a second conversation and drive a turn in it, which pushes upserts naming only
    // that conversation.
    await page.locator('[data-testid="new-session"]').click();
    await chat.completeTurn("hello from another conversation");

    // The subagent must still be there, either as a row or collapsed behind the
    // subagent-count affordance since its parent is no longer active.
    const stillListed = page.locator(SUBAGENT_ROW);
    const collapsed = page.locator('[data-testid="subagent-count"]');
    await expect
      .poll(async () => (await stillListed.count()) + (await collapsed.count()), {
        timeout: 20_000,
        message: "an unrelated upsert evicted the subagent from the sidebar",
      })
      .toBeGreaterThan(0);

    // Switch back to the parent so the branch re-expands, which also restores the
    // precondition assertMatchesServer checks.
    await page.locator(`[data-testid="session-item"][data-conversation-id="${parentId}"]`).click();
    await expect(page.locator(SUBAGENT_ROW)).toHaveCount(1, { timeout: 20_000 });
    await assertMatchesServer(page, request, baseURL, "after an unrelated conversation upserts");
  });

  test("the Chats panel's Stop removes the child without leaving the parent", async ({ chat, page }) => {
    await chat.open();
    await chat.completeTurn("~subagent long running job");
    const row = page.locator('[data-testid="chat-row"][data-kind="subagent"]');
    const stop = row.locator('[data-testid="chat-stop"]');
    await row.hover();
    await expect(stop, "a running subagent offers Stop").toBeVisible({ timeout: 60_000 });
    const parentUrl = page.url();

    await stop.click();

    await expect(row, "the subagent must leave the panel").toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(SUBAGENT_ROW), "the subagent must leave the sidebar").toHaveCount(0);
    expect(page.url(), "Stop must not navigate to the child").toBe(parentUrl);
    // A reload re-lists from the server, so this proves the delete landed there too.
    await page.reload();
    await expect(page.locator('[data-testid="session-item"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(SUBAGENT_ROW), "the subagent must stay gone after a reload").toHaveCount(0);
  });

  test("a session a pod service creates nests under its parent with a VS Code marker", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    await chat.open();
    await chat.completeTurn("hello");
    const parentId = await page.locator(TOP_LEVEL_ROW).getAttribute("data-conversation-id");
    const base = baseURL ?? "http://localhost:5173";

    const res = await request.post(`${base}/conversations/${parentId}/sessions`, { data: { title: "Refactor the router", origin: "vscode" } });
    expect(res.status()).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const row = page.locator(`[data-testid="session-item"][data-conversation-id="${id}"]`);
    await expect(row).toHaveAttribute("data-subagent", "true", { timeout: 30_000 });
    await expect(row).toHaveAttribute("data-session-kind", "session");
    await expect(row.locator('[data-testid="child-icon"][data-origin="vscode"]')).toBeVisible();
    await shot(page, "vscode session row");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(1_000);
    await shot(page, "vscode session row dark");
    await page.emulateMedia({ colorScheme: "light" });

    const listed = await request.get(`${base}/conversations/${parentId}/sessions`);
    expect(((await listed.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([id]);
  });

  test("the Chats panel's New session starts a web session that nests under its parent and opens", async ({ chat, page }) => {
    await chat.open();
    await chat.completeTurn("hello");
    const parent = page.locator(TOP_LEVEL_ROW).first();
    const parentId = await parent.getAttribute("data-conversation-id");

    await page.locator('[data-testid="chats-new-session"]').click();

    const row = page.locator(`${SUBAGENT_ROW}[data-session-kind="session"]`);
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row).toHaveAttribute("data-active", "true", { timeout: 20_000 });
    await expect(row.locator('[data-testid="child-icon"]')).toHaveAttribute("data-origin", "web");
    await expect(row.locator('[data-testid="session-title"]')).toHaveText("New chat");
    const childId = await row.getAttribute("data-conversation-id");
    expect(childId).not.toBe(parentId);

    // The Chats panel lists both, with the session current.
    const chats = page.locator('[data-testid="chat-row"]');
    await expect(chats).toHaveCount(2);
    await expect(page.locator('[data-testid="chat-row"][data-current="true"]')).toHaveAttribute("data-kind", "session");
    await shot(page, "web session from the chats panel");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(500);
    await shot(page, "web session from the chats panel dark");
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("the Chats panel's caret starts a session from context, opening on a forked-from card", async ({ chat, page }) => {
    await chat.open();
    await chat.completeTurn("plan the deploy pipeline");
    const parent = page.locator(TOP_LEVEL_ROW).first();
    await expect(parent.locator('[data-testid="session-title"]')).not.toHaveText(/new chat/i, { timeout: 30_000 });
    const parentTitle = (await parent.locator('[data-testid="session-title"]').textContent())?.trim() ?? "";

    await page.locator('[data-testid="chats-new-session-menu"]').click();
    const fromContext = page.locator('[data-testid="chats-new-session-summary"]');
    await expect(fromContext).toHaveText("New session from context");
    await shot(page, "new session caret menu");
    await fromContext.click();

    const row = page.locator(`${SUBAGENT_ROW}[data-session-kind="session"]`);
    await expect(row).toHaveAttribute("data-active", "true", { timeout: 30_000 });
    const card = page.locator('[data-testid="session-seed-card"]');
    await expect(card).toContainText(`Forked from ${parentTitle}`);
    await card.locator('[data-testid="session-seed-toggle"]').click();
    await expect(card.locator('[data-testid="session-seed-body"]')).toContainText("plan the deploy pipeline");
    await shot(page, "forked from card");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(500);
    await shot(page, "forked from card dark");
    await page.emulateMedia({ colorScheme: "light" });

    // The card's parent title opens the parent.
    await card.locator('[data-testid="session-seed-parent"]').click();
    await expect(parent).toHaveAttribute("data-active", "true");
  });

  test("a long parent title truncates instead of running under its subagent count", async ({ chat, page }) => {
    await chat.open();
    await chat.completeTurn("~subagent check every flaky shard in the nightly end to end suite and report back");
    await expect(page.locator(SUBAGENT_ROW)).toHaveCount(1, { timeout: 30_000 });
    const parentId = await page.locator(TOP_LEVEL_ROW).first().getAttribute("data-conversation-id");

    // Leaving the parent collapses its subagents behind the count badge.
    await page.locator('[data-testid="new-session"]').click();
    await chat.completeTurn("hello");
    const parent = page.locator(`[data-testid="session-item"][data-conversation-id="${parentId}"]`);
    const badge = parent.locator('[data-testid="subagent-count"]');
    await expect(badge).toBeVisible({ timeout: 20_000 });
    await parent.scrollIntoViewIfNeeded();
    await shot(page, "long parent title with subagent count");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(1_000);
    await shot(page, "long parent title with subagent count dark");
    await page.emulateMedia({ colorScheme: "light" });

    // The title text must clip before reaching the badge.
    const title = await parent.locator('[data-testid="session-title"]').evaluate((el) => {
      const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!.parentElement!;
      const style = getComputedStyle(text);
      return { right: text.getBoundingClientRect().right, clips: style.overflow === "hidden" && text.scrollWidth > text.clientWidth };
    });
    const badgeBox = (await badge.boundingBox())!;
    expect(title.right, "the title must end before the badge starts").toBeLessThanOrEqual(badgeBox.x);
    expect(title.clips, "the title must be truncated, not overflowing").toBe(true);
  });
});
