/**
 * Tier 3 E2E — a LONG conversation doesn't wedge the app.
 *
 * Regression for the "long conversations make it hard to START a new conversation
 * (needs multiple refreshes)" bug. Two failure modes this guards:
 *   1. With a long conversation loaded/replaying, opening a NEW conversation and
 *      sending a prompt must work FIRST TRY — not require a reload. (The real-world
 *      cause was the agent-host going NotReady on a stale pg pool; this asserts the
 *      client side stays responsive while a long integrity replay is in flight.)
 *   2. Reloading on a long conversation must paint it (tail seed) AND still let you
 *      immediately switch to a new conversation and send.
 *
 * Uses the fake agent (deterministic "dummy agent" replies). `sendTurn` is
 * count-based so no turns are dropped (see fixtures).
 */

import { test, expect } from "./fixtures.js";

const sidebar = { item: '[data-testid="session-item"]', newSession: '[data-testid="new-session"]' };

// Enough turns that the switch-back/reload goes through the /tail + full-replay path
// (a genuinely long log), not the trivial 1-run case.
const LONG = ["m1-aaa", "m2-bbb", "m3-ccc", "m4-ddd", "m5-eee", "m6-fff", "m7-ggg", "m8-hhh"];

test.describe("long conversation doesn't block a new one", () => {
  test("start + send a NEW conversation immediately after a long one is loaded", async ({ chat, page }) => {
    await chat.open();
    for (const m of LONG) await chat.sendTurn(`turn ${m}`);
    await expect(chat.userMessages()).toHaveCount(LONG.length, { timeout: 45_000 });

    // Now (long conversation live in the thread) start a NEW conversation and send —
    // this must succeed on the FIRST attempt (the bug needed multiple refreshes).
    await page.locator(sidebar.newSession).click();
    await chat.sendTurn("brand new conversation first-try", 45_000);

    // The new conversation shows exactly its own single turn + reply — the long
    // conversation's history is NOT bleeding in, and the send wasn't dropped.
    await expect(chat.userMessages().filter({ hasText: /brand new conversation first-try/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages()).toHaveCount(1);
    await expect(chat.userMessages().filter({ hasText: /turn m8-hhh/i })).toHaveCount(0);
  });

  test("reload ON a long conversation, then start a new one first-try", async ({ chat, page }) => {
    await chat.open();
    for (const m of LONG) await chat.sendTurn(`turn ${m}`);
    await expect(chat.userMessages()).toHaveCount(LONG.length, { timeout: 45_000 });

    // Reload with the long conversation open — the tail seed paints it fast, then the
    // full integrity replay streams. The UI must stay interactive throughout.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    // The tail seed should have painted the latest turn (fast first paint).
    await expect(chat.userMessages().filter({ hasText: /turn m8-hhh/i })).toHaveCount(1, { timeout: 30_000 });

    // WITHOUT waiting for the full replay to finish, immediately open a new
    // conversation and send — it must work first try.
    await page.locator(sidebar.newSession).click();
    await chat.sendTurn("after-reload new conversation", 45_000);
    await expect(chat.userMessages().filter({ hasText: /after-reload new conversation/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages()).toHaveCount(1);
  });
});
