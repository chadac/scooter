/**
 * Tier 3 E2E — SUBAGENT CONVERSATIONS.
 *
 * A subagent is a full conversation that shares its parent's sandbox. Three rules
 * define how it must appear, and nothing covered any of them end to end:
 *
 *   1. it renders NESTED under its parent (a depth-1 row),
 *   2. the parent shows it as a sub-conversation (the Subagents panel),
 *   3. it never renders INDEPENDENTLY — as a top-level chat of its own.
 *
 * Why this could only be caught here: a subagent is reachable only through the
 * agent (the `spawn_subagent` MCP tool), so no test could produce a real parent/child
 * pair. The fake agent's `~subagent` directive now calls that tool exactly as goose
 * does, so the pair is real all the way down — a second conversation row, its own
 * Conversation CR, its own event log — and the assertions below are about what the
 * user actually sees.
 *
 * The regression this pins: the sidebar folds live `/conversations/events` frames with
 * the same merge the 10s poll uses. A single-row `upsert` carries no information about
 * rows it does not mention, but the merge treated absence as "this subagent ended" and
 * evicted EVERY subagent on each unrelated frame — so subagents flickered out of the
 * sidebar and came back on the next poll. Why: PR #568.
 */

import { test, expect, assertMatchesServer } from "./fixtures.js";
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

    // RULE 1 + 3: it appears as a NESTED row, and the top-level count is unchanged —
    // a subagent that leaked into the sidebar as its own chat would bump this to 2.
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

    // It is a REAL conversation: it carries a server id, distinct from its parent's.
    const subId = await nested.getAttribute("data-conversation-id");
    const parentId = await page.locator(TOP_LEVEL_ROW).getAttribute("data-conversation-id");
    expect(subId, "the subagent row must carry a server conversation id").toBeTruthy();
    expect(subId).not.toBe(parentId);

    // RULE 2: the parent shows it as a sub-conversation. The tab only renders when the
    // parent can actually resolve its children, so its presence is the assertion.
    const tab = page.locator('[data-testid="right-panel-tab-subagents"]');
    await expect(tab, "the parent must offer a Subagents tab").toBeVisible();
    await tab.click();
    const panelRows = page.locator('[data-testid="subagent-row"]');
    await expect(panelRows).toHaveCount(1);
    await expect(panelRows.first()).toContainText("investigate the broker timeout");

    // The sidebar and the server agree about what exists.
    await assertMatchesServer(page, request, baseURL, "after spawning a subagent");
  });

  test("a subagent SURVIVES live upserts for other conversations", async ({ chat, page, request, baseURL }) => {
    // The eviction bug needed two things: a subagent in the sidebar, and a live
    // single-row upsert about something else. A new conversation being created and
    // titled produces exactly that frame — and used to wipe the subagent row.
    await chat.open();
    await chat.completeTurn("~subagent watch the deploy");
    await expect(page.locator(SUBAGENT_ROW)).toHaveCount(1, { timeout: 30_000 });
    const parentId = await page.locator(TOP_LEVEL_ROW).first().getAttribute("data-conversation-id");
    expect(parentId).toBeTruthy();

    // Start a SECOND conversation and drive a turn in it. Creating it, then the agent
    // titling it, each push an upsert naming only that conversation.
    await page.locator('[data-testid="new-session"]').click();
    await chat.completeTurn("hello from another conversation");

    // The subagent must still be there. Its parent is no longer active, so the branch
    // AUTO-COLLAPSES and the row is legitimately hidden behind a "▸ 1 subagent"
    // affordance — either form proves the sidebar still knows about it. Eviction shows
    // up as NEITHER being present.
    const stillListed = page.locator(SUBAGENT_ROW);
    const collapsed = page.locator('[data-testid="subagent-count"]');
    await expect
      .poll(async () => (await stillListed.count()) + (await collapsed.count()), {
        timeout: 20_000,
        message: "an unrelated upsert evicted the subagent from the sidebar",
      })
      .toBeGreaterThan(0);

    // Switch back to the parent: the branch re-expands and the nested row is real again.
    // (This also restores the "every server conversation is shown" precondition that
    // assertMatchesServer checks — a collapsed subagent is deliberately not rendered.)
    await page.locator(`[data-testid="session-item"][data-conversation-id="${parentId}"]`).click();
    await expect(page.locator(SUBAGENT_ROW)).toHaveCount(1, { timeout: 20_000 });
    await assertMatchesServer(page, request, baseURL, "after an unrelated conversation upserts");
  });
});
