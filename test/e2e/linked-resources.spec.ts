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

async function currentThreadId(page: import("@playwright/test").Page): Promise<string> {
  // Poll for serverId with retries — it's set asynchronously after the conversation
  // is created on the server, so there's a race between the reply arriving and the
  // serverId being persisted to localStorage. (A single un-polled read here raced
  // that persistence even on the fast stack; on the full target the create also
  // round-trips the router to the owning agent-host pod, so poll for up to 15s.)
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

test.describe("linked resources panel", () => {
  test("a pushed link appears in the panel for the current conversation", async ({ chat, page, request, baseURL }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75 for the pattern). On the
    // full target the first reply is gated on a REAL sandbox boot (5-25s cold)
    // before the fake agent's echo tool call can run. Arithmetic: reply worst
    // case ~90s + the panel's link poll (30s worst) already overruns the 60s
    // default, which was written against the ~1s fake stack.
    test.setTimeout(150_000);
    const base = baseURL ?? "http://localhost:5173";

    await chat.open();
    await chat.send("opening message");
    await chat.waitForReply(/dummy agent/i, 90_000);

    // Discover the UI's current thread id (polls — see currentThreadId).
    const threadId = await currentThreadId(page);

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
    //
    // 90s, not 30. The panel refreshes on a 10s setInterval (LinkedResources.tsx), so 30s is
    // only ~3 attempts, and on the full target each attempt round-trips the router to the pod
    // that owns the conversation — a poll landing during churn returns an empty list and burns
    // one of the three. Observed on CI: the POST above returned ok (asserted), and the panel
    // still had not rendered when the 30s expired. 90s gives the interval ~9 attempts, which
    // is the same "let the cluster's own refresh cadence happen" budget the sidebar row waits
    // in chat-search-filter use.
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 90_000 });
    const item = page.locator(panel.item).filter({ hasText: /example-org\/example-app #203/i });
    await expect(item).toHaveCount(1, { timeout: 30_000 });
    // It links out to the PR.
    await expect(item.locator("a")).toHaveAttribute("href", /github\.com\/example-org\/example-app\/pull\/203/);
  });

  test("the panel is hidden when a conversation has no links", async ({ chat, page }) => {
    // CLUSTER-HONEST BUDGET: one cold-provisioned turn (~90s worst) + the
    // absence assertion; the 60s default only fit the fake stack's ~1s turn.
    test.setTimeout(150_000);
    await chat.open();
    await chat.send("no links here");
    await chat.waitForReply(/dummy agent/i, 90_000);
    await expect(page.locator(panel.root)).toHaveCount(0);
  });

  test("a conversation with a link shows a provider icon in the sidebar row", async ({ chat, page, request, baseURL }) => {
    // CLUSTER-HONEST BUDGET: cold-provisioned first reply (~90s worst) + the
    // sidebar's /conversations merge poll (30s worst) overruns the 60s default.
    test.setTimeout(150_000);
    const base = baseURL ?? "http://localhost:5173";
    await chat.open();
    await chat.send("opening message");
    await chat.waitForReply(/dummy agent/i, 90_000);

    const threadId = await currentThreadId(page);

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
    // 90s for the same reason as the panel assertion above: this is a poll-driven read whose
    // every attempt round-trips the router on the full target, so a handful of attempts is
    // not a meaningful sample when a pod is churning.
    const icon = row.locator('[data-testid="source-icon"][data-source="github"]');
    await expect(icon).toHaveCount(1, { timeout: 90_000 });
  });
});
