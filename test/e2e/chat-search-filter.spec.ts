/**
 * Tier 3 E2E — sidebar chat search, provider filter, and Titles/Links label mode.
 *
 * Two conversations: one linked to a GitHub PR (pushed via the links API, as a
 * webhook would), one plain. Exercises (1) keyword search over title + link name,
 * (2) the provider filter chips, and (3) the Titles/Links toggle that swaps a row's
 * conversation title for its linked-resource name.
 */

import { test, expect } from "./fixtures.js";

const sb = {
  item: '[data-testid="session-item"]',
  title: '[data-testid="session-title"]',
  search: '[data-testid="session-search"]',
  labelTitle: '[data-testid="label-title"]',
  labelLink: '[data-testid="label-link"]',
  providerGithub: '[data-testid="provider-github"]',
  providerNone: '[data-testid="provider-none"]',
  empty: '[data-testid="session-empty"]',
  scopeAll: '[data-testid="scope-all"]',
};

async function currentThreadId(page: import("@playwright/test").Page): Promise<string> {
  const id = await page.evaluate(() => {
    const raw = window.localStorage.getItem("kubenix-agent.sessions.v1");
    return raw ? (JSON.parse(raw) as { currentId: string }).currentId : "";
  });
  expect(id).toBeTruthy();
  return id;
}

test.describe("sidebar search + filter + label mode", () => {
  test("search, provider chips, and the Titles/Links toggle", async ({ chat, page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";

    // Conversation A: will be linked to a GitHub PR.
    await chat.open();
    await chat.send("investigate the flaky broker test");
    await chat.waitForReply(/dummy agent/i);
    const threadA = await currentThreadId(page);
    const r = await request.post(`${base}/conversations/${threadA}/links`, {
      data: {
        source: "github",
        resourceType: "pull_request",
        url: "https://github.com/example-org/example-app/pull/203",
        title: "example-org/example-app #203",
      },
    });
    expect(r.ok()).toBeTruthy();

    // Conversation B: plain, no links.
    await page.locator('[data-testid="new-session"]').click();
    await chat.send("just some scratch notes");
    await chat.waitForReply(/dummy agent/i);

    // Show all conversations (both rows regardless of owner).
    await page.locator(sb.scopeAll).click();
    await expect(page.locator(sb.item)).toHaveCount(2, { timeout: 30_000 });

    // (1) Keyword search matches the LINK NAME (not present in either title).
    await page.locator(sb.search).fill("#203");
    await expect(page.locator(sb.item)).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(sb.title).first()).toHaveText(/flaky broker/i);

    // Search matches a plain title too.
    await page.locator(sb.search).fill("scratch");
    await expect(page.locator(sb.item)).toHaveCount(1);
    // A non-matching query yields the empty-state.
    await page.locator(sb.search).fill("zzz-nomatch");
    await expect(page.locator(sb.empty)).toBeVisible();
    await page.locator(sb.search).fill("");

    // (2) Provider filter: GitHub shows only the linked conversation.
    await page.locator(sb.providerGithub).click();
    await expect(page.locator(sb.item)).toHaveCount(1);
    await expect(page.locator(sb.title).first()).toHaveText(/flaky broker/i);
    await page.locator(sb.providerGithub).click(); // toggle off

    // "None" shows only the UNLINKED conversation.
    await page.locator(sb.providerNone).click();
    await expect(page.locator(sb.item)).toHaveCount(1);
    await expect(page.locator(sb.title).first()).toHaveText(/scratch/i);
    await page.locator(sb.providerNone).click(); // toggle off
    await expect(page.locator(sb.item)).toHaveCount(2);

    // (3) Links mode: the linked row shows the PR name instead of its title.
    await page.locator(sb.labelLink).click();
    await expect(
      page.locator(sb.title).filter({ hasText: /example-org\/example-app #203/i }),
    ).toHaveCount(1, { timeout: 30_000 });
    // The unlinked row still falls back to its title.
    await expect(page.locator(sb.title).filter({ hasText: /scratch/i })).toHaveCount(1);
    // Back to Titles mode: the link name is gone, the title returns.
    await page.locator(sb.labelTitle).click();
    await expect(
      page.locator(sb.title).filter({ hasText: /example-org\/example-app #203/i }),
    ).toHaveCount(0);
  });
});
