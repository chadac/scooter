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

  test("a conversation with a link shows a provider icon in the sidebar row", async ({ chat, page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    await chat.open();
    await chat.send("opening message");
    await chat.waitForReply(/dummy agent/i);

    const threadId = await page.evaluate(() => {
      const raw = window.localStorage.getItem("kubenix-agent.sessions.v1");
      return raw ? (JSON.parse(raw) as { currentId: string }).currentId : "";
    });
    expect(threadId).toBeTruthy();

    // Target THIS conversation's row via data-active, not `.first()`. The sidebar sorts
    // newest-first, so a conversation created by another spec on the shared backend can take the
    // top slot between the open() above and the assertion below — the icon then lands on a row
    // this locator is not looking at, and the test fails on ordering rather than on the behaviour
    // under test. The conversation under test is the selected one, so data-active pins it.
    const row = page.locator('[data-testid="session-item"][data-active="true"]');
    await expect(row, "this conversation's own sidebar row (the ACTIVE one)").toHaveCount(1, { timeout: 20_000 });
    // No provider icon on the row before any link.
    await expect(row.locator('[data-testid="source-icon"]')).toHaveCount(0);

    // Push a GitHub link (as the webhooks service would).
    const r = await request.post(`${base}/conversations/${threadId}/links`, {
      data: { source: "github", resourceType: "pull_request", url: "https://github.com/example-org/example-app/pull/203" },
    });
    expect(r.ok()).toBeTruthy();

    // The sidebar row picks up the github badge via the /conversations merge poll.
    const icon = row.locator('[data-testid="source-icon"][data-source="github"]');
    await expect(icon).toHaveCount(1, { timeout: 30_000 });
  });
});

test.describe("linked resources durability (mirror fallback after rollout)", () => {
  test("a link survives suspend/revive (rollout wipes LOCAL_STATE_PATH, must read from mirror)", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    // THE BUG: listLinks reads from LOCAL only (an emptyDir wiped on rollouts), even
    // though addLink writes to BOTH stores. After a rollout, LOCAL is empty but the
    // MIRROR holds the real data. Reading local-only makes links disappear.
    //
    // Measured on cluster: 5 of 12 links missing (those from pre-rollout conversations).
    //
    // This test simulates a rollout via suspend (which tears down the pod, wiping the
    // emptyDir). The link must survive and appear after revive.
    const base = baseURL ?? "http://localhost:5173";

    await chat.open();
    await chat.send("initial message");
    await chat.waitForReply(/dummy agent/i);

    // Discover the conversation id.
    const threadId = await page.evaluate(() => {
      const raw = window.localStorage.getItem("kubenix-agent.sessions.v1");
      return raw ? (JSON.parse(raw) as { currentId: string }).currentId : "";
    });
    expect(threadId).toBeTruthy();

    // Push a link (as the webhooks service would).
    const linkRes = await request.post(`${base}/conversations/${threadId}/links`, {
      data: {
        source: "github",
        resourceType: "pull_request",
        url: "https://github.com/test-org/test-repo/pull/999",
        title: "test-org/test-repo #999",
      },
    });
    expect(linkRes.ok()).toBeTruthy();

    // Verify the link appears initially.
    const panel = {
      root: '[data-testid="linked-resources"]',
      item: '[data-testid="linked-resource"]',
    };
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    const itemBefore = page.locator(panel.item).filter({ hasText: /test-org\/test-repo #999/i });
    await expect(itemBefore).toHaveCount(1, { timeout: 30_000 });

    // SUSPEND (simulates a rollout: tears down the pod, wipes LOCAL_STATE_PATH emptyDir).
    const suspendRes = await request.post(`${base}/conversations/${encodeURIComponent(threadId)}/suspend`);
    expect(suspendRes.ok(), "suspend must succeed").toBeTruthy();

    // REVIVE by sending a message (the real user path).
    await chat.send("message after rollout");
    await expect(
      chat.userMessages().filter({ hasText: /message after rollout/i }),
    ).toHaveCount(1, { timeout: 30_000 });

    // THE ASSERTION: the link must STILL be visible after the revive.
    // LOCAL_STATE_PATH was wiped by the suspend, so this read MUST come from the
    // durable mirror, not the local cache. If listLinks reads local-only, this fails.
    await expect(page.locator(panel.root), "the linked-resources panel must reappear after revive").toBeVisible({
      timeout: 30_000,
    });
    const itemAfter = page.locator(panel.item).filter({ hasText: /test-org\/test-repo #999/i });
    await expect(
      itemAfter,
      "the link must survive the suspend/revive (rollout) — reading from the durable mirror, not wiped local",
    ).toHaveCount(1, { timeout: 30_000 });
  });
});
