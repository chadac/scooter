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
  filtersToggle: '[data-testid="filters-toggle"]',
  providerGithub: '[data-testid="provider-github"]',
  labelTitle: '[data-testid="label-title"]',
  labelGithub: '[data-testid="label-github"]',
  labelSlack: '[data-testid="label-slack"]',
  empty: '[data-testid="session-empty"]',
  scopeAll: '[data-testid="scope-all"]',
};

async function currentThreadId(page: import("@playwright/test").Page): Promise<string> {
  // Poll for serverId with retries — it's set asynchronously after the conversation
  // is created on the server, so there's a race between the reply arriving and the
  // serverId being persisted to localStorage.
  // 150 × 100ms = 15s: the fast stack lands serverId in well under the old 5s
  // budget, but on the full (cluster) target the create round-trips the router
  // to the owning agent-host pod, so give the persistence race real room.
  let id = "";
  for (let i = 0; i < 150; i++) {
    id = await page.evaluate(() => {
      const raw = window.localStorage.getItem("kubenix-agent.sessions.v1");
      // The SERVER's id, not `currentId` — that is the stable local KEY, which for a
      // conversation created on its first send is a placeholder the server never issued.
      if (!raw) return "";
      const st = JSON.parse(raw) as {
        currentId?: string;
        sessions?: Array<{ id: string; serverId?: string }>;
      };
      return st.sessions?.find((s) => s.id === st.currentId)?.serverId ?? "";
    });
    if (id) break;
    await page.waitForTimeout(100);
  }
  expect(id).toBeTruthy();
  return id;
}

test.describe("sidebar search + filter + label mode", () => {
  test("search, provider chips, and the Titles/Links toggle", async ({ chat, page, request, baseURL }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75 for the pattern). This test
    // creates TWO conversations, and on the full target each first reply is gated
    // on a REAL sandbox boot (5-25s cold) before the fake agent's echo tool call
    // can run — and CI forces CONVERSATION_POD_CAP=1, so A and B land on
    // DIFFERENT pods and NEITHER boot is warm. Arithmetic: 2 × (provision 15-25s
    // + turn ~2s) + the sidebar link-merge poll (30s worst) + the label-mode poll
    // (30s worst) ≈ 115-145s worst case — far past the 60s default that was
    // written against the ~1s fake stack.
    test.setTimeout(240_000);
    const base = baseURL ?? "http://localhost:5173";

    // Conversation A: will be linked to a GitHub PR. 90s reply budget: cold
    // sandbox provision (up to ~25s, longer when the CI node is briefly out of
    // cpu) precedes the fake agent's real echo exec.
    await chat.open();
    await chat.send("investigate the flaky broker test");
    await chat.waitForReply(/dummy agent/i, 90_000);
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

    // Conversation B: plain, no links. Same 90s budget — under podCap=1 this
    // conversation provisions its own sandbox on another pod (no warm reuse).
    await page.locator('[data-testid="new-session"]').click();
    await chat.send("just some scratch notes");
    await chat.waitForReply(/dummy agent/i, 90_000);

    // Open the advanced-filters panel (Scope / Linked / Show live inside it).
    await page.locator(sb.filtersToggle).click();
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

    // (2) Provider filter (icon chips): GitHub shows only the linked conversation.
    await page.locator(sb.providerGithub).click();
    await expect(page.locator(sb.item)).toHaveCount(1);
    await expect(page.locator(sb.title).first()).toHaveText(/flaky broker/i);
    await page.locator(sb.providerGithub).click(); // toggle off
    await expect(page.locator(sb.item)).toHaveCount(2);

    // (3) "Show" segmented control -> GitHub: the linked row shows the PR name; the
    // unlinked row falls back to its title.
    await page.locator(sb.labelGithub).click();
    await expect(
      page.locator(sb.title).filter({ hasText: /example-org\/example-app #203/i }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(sb.title).filter({ hasText: /scratch/i })).toHaveCount(1);
    // Under a provider the linked row doesn't have (Slack), it falls back to its title.
    await page.locator(sb.labelSlack).click();
    await expect(
      page.locator(sb.title).filter({ hasText: /example-org\/example-app #203/i }),
    ).toHaveCount(0);
    // Back to the Scooter/title mode.
    await page.locator(sb.labelTitle).click();
    await expect(page.locator(sb.title).filter({ hasText: /flaky broker/i })).toHaveCount(1);
  });
});
