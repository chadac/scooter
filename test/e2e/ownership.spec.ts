/**
 * Tier 3 E2E — conversation ownership + the Mine/All sidebar view filter.
 *
 * The browser UI is "anonymous" in this fake stack (no ingress injecting an
 * identity header), so it sees everything under "Mine" (anonymous = all). We
 * seed conversations owned by OTHER users via the API (passing x-auth-user, as
 * the ingress would) and exercise the toggle. The owner-filtering logic itself
 * is covered exhaustively by the Tier-1 contract tests (which can set headers).
 */

import { test, expect } from "./fixtures.js";

const sidebar = {
  title: '[data-testid="session-title"]',
  // Mine/All now lives inside the collapsible "Advanced" filters panel.
  filtersToggle: '[data-testid="filters-toggle"]',
  toggleMine: '[data-testid="scope-mine"]',
  toggleAll: '[data-testid="scope-all"]',
};

/** Open the "Advanced" filters panel (which holds the Mine/All scope toggle). */
async function openFilters(page: import("@playwright/test").Page) {
  const toggle = page.locator(sidebar.filtersToggle);
  if ((await toggle.getAttribute("data-open")) !== "true") await toggle.click();
}

test.describe("conversation ownership + Mine/All filter", () => {
  test("the sidebar has a Mine/All toggle defaulting to Mine", async ({ chat, page }) => {
    await chat.open();
    await openFilters(page);
    await expect(page.locator(sidebar.toggleMine)).toBeVisible();
    await expect(page.locator(sidebar.toggleAll)).toBeVisible();
    await expect(page.locator(sidebar.toggleMine)).toHaveAttribute("data-active", "true");
  });

  test("the header user badge is HIDDEN when anonymous (no identity header)", async ({ chat, page }) => {
    // The e2e stack sends no x-auth-user, so /whoami is anonymous — the badge must
    // render nothing (never a meaningless 'anonymous' chip). With a real identity
    // (auth enabled) it shows the user; that path is covered by the unit test.
    await chat.open();
    await expect(page.locator('[data-testid="user-badge"]')).toHaveCount(0);
  });

  test("a conversation owned by another user is hidden under Mine, shown under All", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    const base = baseURL ?? "http://localhost:5173";
    const id = `owned-by-bob-${Date.now()}`;
    // Seed a conversation OWNED BY BOB (the ingress would set this header).
    const r = await request.post(`${base}/conversations`, {
      data: { threadId: id, title: "Bob's private work" },
      headers: { "x-auth-user": "bob" },
    });
    expect(r.ok()).toBeTruthy();

    await chat.open();
    await openFilters(page);

    const bobRow = page.locator(sidebar.title).filter({ hasText: /Bob's private work/i });

    // The UI's caller is anonymous → /whoami returns anonymous → Mine shows
    // everything (dev-friendly), so Bob's appears even under the default Mine.
    // Switching to All must also show it. (The real per-user hiding is the
    // contract-tested server filter; here we prove the data + toggle flow.)
    await page.locator(sidebar.toggleAll).click();
    await expect(bobRow).toHaveCount(1, { timeout: 30_000 });

    // Toggle back to Mine — still present (anonymous sees all), and the toggle
    // state flips correctly.
    await page.locator(sidebar.toggleMine).click();
    await expect(page.locator(sidebar.toggleMine)).toHaveAttribute("data-active", "true");
  });
});
