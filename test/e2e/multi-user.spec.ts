/**
 * Tier 3 E2E — TRUE multi-user ownership: two distinct identities in the same
 * agent-host, each seeing their own conversations under "Mine".
 *
 * Unlike ownership.spec.ts (which runs the browser as anonymous, so "Mine" shows
 * everything and the my-vs-others distinction is never exercised), this drives
 * two browser CONTEXTS with different `x-auth-user` headers — the ingress
 * identity the real deployment injects. So /whoami returns a real user and the
 * "Mine" filter actually distinguishes.
 *
 * Asserts the STRICT policy: for a KNOWN user, "Mine" = strictly owner==me —
 * another user's chats AND unowned chats are hidden under Mine, shown under All.
 * Anonymous still sees all (dev-friendly), covered by ownership.spec.ts.
 */

import { test, expect, type Browser, type Page } from "@playwright/test";

const sel = {
  title: '[data-testid="session-title"]',
  filtersToggle: '[data-testid="filters-toggle"]',
  toggleMine: '[data-testid="scope-mine"]',
  toggleAll: '[data-testid="scope-all"]',
  userBadge: '[data-testid="user-badge"]',
};

/** A page in a context that carries `user` as the ingress identity header. */
async function pageAs(browser: Browser, user: string, email?: string): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: {
      "x-auth-user": user,
      ...(email ? { "x-auth-email": email } : {}),
    },
  });
  return context.newPage();
}

/** Seed a conversation owned by `user` via the API (as the ingress would). */
async function seedConversation(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  user: string | null,
  title: string,
): Promise<string> {
  const id = `${title.replace(/\W+/g, "-").toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const r = await request.post(`${base}/conversations`, {
    data: { threadId: id, title },
    headers: user ? { "x-auth-user": user } : {},
  });
  expect(r.ok()).toBeTruthy();
  return id;
}

async function openFilters(page: Page) {
  const toggle = page.locator(sel.filtersToggle);
  if ((await toggle.getAttribute("data-open")) !== "true") await toggle.click();
}

test.describe("multi-user ownership (Mine strictly distinguishes)", () => {
  test("alice sees only alice's chats under Mine; bob's + unowned are All-only", async ({
    browser,
    request,
    baseURL,
  }) => {
    const base = baseURL ?? "http://localhost:5173";

    // Seed three conversations: alice's, bob's, and an unowned one.
    await seedConversation(request, base, "alice", "Alice private plan");
    await seedConversation(request, base, "bob", "Bob private plan");
    await seedConversation(request, base, null, "Legacy unowned chat");

    const alice = await pageAs(browser, "alice", "alice@x.io");
    await alice.goto("/");
    await openFilters(alice);

    // Mine (the default) for a KNOWN user = strictly her own.
    await expect(alice.locator(sel.toggleMine)).toHaveAttribute("data-active", "true");
    await expect(
      alice.locator(sel.title).filter({ hasText: /Alice private plan/i }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(alice.locator(sel.title).filter({ hasText: /Bob private plan/i })).toHaveCount(0);
    await expect(alice.locator(sel.title).filter({ hasText: /Legacy unowned chat/i })).toHaveCount(0);

    // All shows everything (hers, bob's, unowned).
    await alice.locator(sel.toggleAll).click();
    await expect(alice.locator(sel.title).filter({ hasText: /Bob private plan/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(alice.locator(sel.title).filter({ hasText: /Legacy unowned chat/i })).toHaveCount(1);
  });

  test("bob's Mine shows bob's, not alice's — symmetric isolation", async ({
    browser,
    request,
    baseURL,
  }) => {
    const base = baseURL ?? "http://localhost:5173";
    await seedConversation(request, base, "alice", "Alice symmetric");
    await seedConversation(request, base, "bob", "Bob symmetric");

    const bob = await pageAs(browser, "bob", "bob@x.io");
    await bob.goto("/");
    await openFilters(bob);

    await expect(bob.locator(sel.title).filter({ hasText: /Bob symmetric/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(bob.locator(sel.title).filter({ hasText: /Alice symmetric/i })).toHaveCount(0);
  });

  test("the user badge shows the ingress identity (non-anonymous)", async ({ browser }) => {
    const alice = await pageAs(browser, "alice", "alice@x.io");
    await alice.goto("/");
    // With a real identity, the badge renders (email preferred).
    await expect(alice.locator(sel.userBadge)).toHaveCount(1, { timeout: 20_000 });
    await expect(alice.locator(sel.userBadge)).toContainText(/alice/i);
  });
});
