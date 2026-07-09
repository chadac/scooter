/**
 * Tier 3 E2E — the conversation scroll-locks to the bottom by default.
 *
 * The thread viewport (assistant-ui ThreadPrimitive.Viewport) is bottom-anchored
 * (turnAnchor="bottom"), so as turns stream in the view FOLLOWS the latest content
 * instead of stranding the user mid-history. The lock releases when the user
 * scrolls up, and the scroll-to-bottom arrow re-engages it.
 *
 * Runs against the local dummy-agent stack (see conversation.spec.ts).
 */

import { test, expect } from "./fixtures.js";

// "At the bottom" tolerance in px. Not 0/±1: `scroll-smooth` + sub-pixel scrollHeight
// rounding leave a few px of slop after the settle (CI headless landed at ~5). This is
// far below a message's height, so it still proves the view followed to the bottom vs.
// being stranded mid-history (which is hundreds of px off).
const AT_BOTTOM_PX = 40;
// "Clearly scrolled up" — we scroll to the very top, so the real distance is hundreds
// of px; anything well past AT_BOTTOM_PX proves the lock released.
const SCROLLED_UP_PX = 100;

test.describe("conversation scroll-lock", () => {
  test("auto-follows new turns to the bottom", async ({ chat }) => {
    await chat.open();

    // Send enough turns that the thread overflows the viewport — otherwise there's
    // nothing to scroll and the assertion is vacuous.
    for (let i = 0; i < 6; i++) {
      await chat.sendTurn(`turn number ${i} please review something moderately long`);
    }

    // With scroll-lock on, the viewport rode each new turn down to the bottom.
    await expect.poll(async () => chat.distanceFromBottom(), { timeout: 10_000 }).toBeLessThanOrEqual(AT_BOTTOM_PX);
  });

  test("scrolling up releases the lock; the arrow re-engages it", async ({ chat, page }) => {
    await chat.open();
    for (let i = 0; i < 6; i++) {
      await chat.sendTurn(`turn number ${i} please review something moderately long`);
    }
    await expect.poll(async () => chat.distanceFromBottom(), { timeout: 10_000 }).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // Scroll UP — the lock releases (we're no longer at the bottom) and the
    // scroll-to-bottom affordance appears.
    await chat.viewport().evaluate((el) => el.scrollTo({ top: 0 }));
    await expect.poll(async () => chat.distanceFromBottom(), { timeout: 5_000 }).toBeGreaterThan(SCROLLED_UP_PX);

    // The scroll-to-bottom arrow (visible only when scrolled up) re-engages the
    // lock — clicking it returns the view to the bottom.
    const arrow = page.locator(".aui-thread-scroll-to-bottom").first();
    await arrow.click();
    await expect.poll(async () => chat.distanceFromBottom(), { timeout: 5_000 }).toBeLessThanOrEqual(2);
  });
});
