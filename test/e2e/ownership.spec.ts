/**
 * e2e — conversation ownership + the Mine/All sidebar view filter.
 *
 * The browser UI is "anonymous" on both targets (no ingress injecting an
 * identity header — neither the fake stack nor the CI k3d deployment has one),
 * so it sees everything under "Mine" (anonymous = all). We seed a conversation
 * owned by ANOTHER user via the API (passing x-auth-user, as the ingress would)
 * and exercise the toggle. The owner-filtering logic itself is covered
 * exhaustively by the Tier-1 contract tests (which can set headers), and the
 * true two-identity story by multi-user.spec.ts.
 *
 * Sidebar rows are located by `data-conversation-id` (the server-minted id) —
 * on the full target the conversation-router's create path drops the title
 * (only owner/model/parentId reach the CR spec), so title text is not a
 * cluster-honest anchor; the id always is.
 */

import { test, expect, seedConversation } from "./fixtures.js";

const sidebar = {
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
    // (auth enabled) it shows the user; that path is covered by the unit test and
    // by multi-user.spec.ts.
    await chat.open();
    await expect(page.locator('[data-testid="user-badge"]')).toHaveCount(0);
  });

  test("a conversation owned by another user is visible to the anonymous UI under Mine and All", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    // CLUSTER-HONEST BUDGET: one seed bounded by seedConversation's 45s adoption
    // ceiling (full target: router CR create → request-driven pod adoption →
    // fleet-list convergence) + a 30s sidebar assertion. The 60s default was
    // written against the ~1s fake-stack seed and fails on arithmetic alone.
    test.setTimeout(120_000);
    const base = (baseURL ?? "http://localhost:5173").replace(/\/$/, "");
    // Seed a conversation OWNED BY BOB (the ingress would set this header).
    const id = await seedConversation(request, base, "bob", "Bob's private work");

    await chat.open();
    await openFilters(page);

    const bobRow = page.locator(`[data-testid="session-item"][data-conversation-id="${id}"]`);

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
    await expect(bobRow).toHaveCount(1);
  });
});
