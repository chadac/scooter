/**
 * Tier 3 E2E for subagent conversations. A subagent is a full conversation that shares its
 * parent's sandbox, and three rules define how it appears: nested under its parent as a
 * depth-1 row, shown by the parent as a sub-conversation in the Subagents panel, and never
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
    const section = page.locator('[data-testid="right-panel-section-subagents"]');
    await expect(section, "the parent's Session tab must offer a Subagents section").toBeVisible();
    await expect(section).toHaveAttribute("data-open", "true");
    const panelRows = page.locator('[data-testid="subagent-row"]');
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

    const res = await request.post(`${base}/conversations/${parentId}/sessions`, { data: { title: "Refactor the router" } });
    expect(res.status()).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const row = page.locator(`[data-testid="session-item"][data-conversation-id="${id}"]`);
    await expect(row).toHaveAttribute("data-subagent", "true", { timeout: 30_000 });
    await expect(row).toHaveAttribute("data-session-kind", "session");
    await expect(row.locator('[data-testid="session-vscode"]')).toBeVisible();
    await shot(page, "vscode session row");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(1_000);
    await shot(page, "vscode session row dark");
    await page.emulateMedia({ colorScheme: "light" });

    const listed = await request.get(`${base}/conversations/${parentId}/sessions`);
    expect(((await listed.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([id]);
  });
});
