/**
 * Tier 3 E2E — a multi-turn conversation re-renders correctly on switch-back.
 *
 * Regression for the recent-tail fast-first-paint (the /tail seed): a longer
 * conversation, switched away from and back to, must show its messages — NOT
 * render empty. The tail seed + the full integrity replay must converge on the
 * populated thread. Drives several turns (enough runs to exercise the tail
 * window), swaps to another conversation, swaps back, and asserts the history is
 * present and the latest turn is visible.
 */

import { test, expect } from "./fixtures.js";

const sidebar = { item: '[data-testid="session-item"]', newSession: '[data-testid="new-session"]' };

test.describe("multi-turn re-render (tail + replay)", () => {
  test("a longer conversation is populated after switching away and back", async ({ chat, page }) => {
    await chat.open();
    // Several turns → several persisted runs, so switching back goes through the
    // /tail window + full replay path (not the trivial 1-run case).
    const markers = ["alpha-111", "beta-222", "gamma-333", "delta-444", "epsilon-555"];
    for (const m of markers) {
      // sendTurn waits for THIS turn's reply (count-based) — waitForReply matched a
      // prior turn's identical "dummy agent" reply and let the next send race an
      // unfinished run, dropping a turn (the flake).
      await chat.sendTurn(`turn ${m}`);
    }
    // All five user turns are present in the live thread.
    await expect(chat.userMessages()).toHaveCount(markers.length, { timeout: 30_000 });

    // Switch to a fresh conversation, then back to the multi-turn one.
    await page.locator(sidebar.newSession).click();
    await chat.send("a different conversation");
    await chat.waitForReply(/dummy agent/i);

    await page.locator(sidebar.item).filter({ hasText: /turn alpha-111/i }).first().click();

    // The switched-back conversation must NOT be empty: its user turns render
    // (from the tail seed and/or the full replay), and the latest is visible.
    await expect(chat.userMessages().filter({ hasText: /turn epsilon-555/i })).toHaveCount(1, { timeout: 30_000 });
    await expect(chat.userMessages()).toHaveCount(markers.length, { timeout: 30_000 });
    // And the other conversation's message is not bleeding in.
    await expect(chat.userMessages().filter({ hasText: /a different conversation/i })).toHaveCount(0);
  });

  test("a long conversation opens PINNED AT THE BOTTOM (not stranded at the top)", async ({ chat, page }) => {
    // The reported bug: opening/switching-back to a long conversation landed at the
    // TOP of history, forcing a scroll-down. With the incremental messageRepository
    // render (stable ids, per-message reconcile, head pinned), it must land at the
    // bottom. Build a thread tall enough to actually scroll first.
    await chat.open();
    const markers = ["m1-aa", "m2-bb", "m3-cc", "m4-dd", "m5-ee", "m6-ff", "m7-gg", "m8-hh"];
    for (const m of markers) {
      await chat.sendTurn(`turn ${m} — a moderately long line so the thread grows tall enough to scroll`);
    }
    await expect(chat.userMessages()).toHaveCount(markers.length, { timeout: 30_000 });

    // Switch away, then back — the open path that used to strand at the top.
    await page.locator(sidebar.newSession).click();
    await chat.send("elsewhere");
    await chat.waitForReply(/dummy agent/i);
    await page.locator(sidebar.item).filter({ hasText: /turn m1-aa/i }).first().click();

    // Fully repopulated…
    await expect(chat.userMessages()).toHaveCount(markers.length, { timeout: 30_000 });
    // …and the thread is genuinely scrollable (else the assertion is vacuous)…
    await expect.poll(() => chat.scrollableHeight(), { timeout: 10_000 }).toBeGreaterThan(200);
    // …AND it opened pinned at the bottom (the latest turn visible, no scroll needed).
    await expect.poll(() => chat.distanceFromBottom(), { timeout: 10_000 }).toBeLessThanOrEqual(40);
    // The scroll-to-bottom arrow is disabled at the bottom (assistant-ui hides it).
    await expect(chat.scrollToBottomButton()).toBeDisabled({ timeout: 10_000 });
  });

  test("a longer conversation is populated after a full page reload", async ({ chat, page }) => {
    await chat.open();
    for (const m of ["one-aaa", "two-bbb", "three-ccc", "four-ddd"]) {
      await chat.sendTurn(`turn ${m}`); // count-based wait — no dropped turns (see fixtures)
    }
    await expect(chat.userMessages()).toHaveCount(4, { timeout: 30_000 });

    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // After reload the thread rebuilds via the tail seed + integrity replay — it
    // must be populated, not empty.
    await expect(chat.userMessages().filter({ hasText: /turn four-ddd/i })).toHaveCount(1, { timeout: 30_000 });
    await expect(chat.userMessages()).toHaveCount(4, { timeout: 30_000 });
  });
});
