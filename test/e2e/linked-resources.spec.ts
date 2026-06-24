/**
 * Tier 3 E2E — the linked-resources panel.
 *
 * The webhooks service pushes a conversation's external resource links (the
 * GitHub PR / Slack thread it came from) to the agent-host; the UI shows them in
 * a collapsible left-panel tab. Here we push a link via the API (as a webhook
 * would) and assert the open UI surfaces it.
 */

import { test, expect } from "./fixtures.js";

const panel = {
  root: '[data-testid="linked-resources"]',
  toggle: '[data-testid="linked-resources-toggle"]',
  item: '[data-testid="linked-resource"]',
};

test.describe("linked resources panel", () => {
  test("a pushed link appears in the panel for the current conversation", async ({ chat, page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";

    await chat.open();
    await chat.send("opening message");
    await chat.waitForReply(/dummy agent/i);

    // Discover the UI's current thread id.
    const threadId = await page.evaluate(() => {
      const raw = window.localStorage.getItem("kubenix-agent.sessions.v1");
      return raw ? (JSON.parse(raw) as { currentId: string }).currentId : "";
    });
    expect(threadId).toBeTruthy();

    // Push a link as the webhooks service would.
    const r = await request.post(`${base}/conversations/${threadId}/links`, {
      data: {
        source: "github",
        resourceType: "pull_request",
        url: "https://github.com/example-org/example-app/pull/203",
        title: "example-org/example-app #203",
      },
    });
    expect(r.ok()).toBeTruthy();

    // The panel appears (poll-driven) with the link.
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    const item = page.locator(panel.item).filter({ hasText: /example-org\/example-app #203/i });
    await expect(item).toHaveCount(1, { timeout: 30_000 });
    // It links out to the PR.
    await expect(item.locator("a")).toHaveAttribute("href", /github\.com\/example-org\/example-app\/pull\/203/);
  });

  test("the panel is hidden when a conversation has no links", async ({ chat, page }) => {
    await chat.open();
    await chat.send("no links here");
    await chat.waitForReply(/dummy agent/i);
    await expect(page.locator(panel.root)).toHaveCount(0);
  });
});
