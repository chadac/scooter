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

import { test, expect, type Chat } from "./fixtures.js";

// "At the bottom" tolerance in px. Not 0/±1: `scroll-smooth` + sub-pixel scrollHeight
// rounding leave a few px of slop after the settle (CI headless landed at ~5). This is
// far below a message's height, so it still proves the view followed to the bottom vs.
// being stranded mid-history.
const AT_BOTTOM_PX = 40;

// Fill the thread until it's comfortably TALLER than the viewport, so the scroll
// assertions aren't vacuous (a thread that fits can't scroll, and the arrow never
// enables). Turn count alone isn't enough on a tall CI viewport with short messages —
// keep sending until there's a healthy amount to scroll (or a safety cap). Returns the
// scrollable height so the caller can scale its "scrolled up" expectation to reality.
async function fillUntilScrollable(chat: Chat, minScroll = 400): Promise<number> {
  let scrollable = 0;
  for (let i = 0; i < 12 && scrollable < minScroll; i++) {
    await chat.sendTurn(`turn number ${i} — please review something moderately long so the thread grows`);
    scrollable = await chat.scrollableHeight();
  }
  return scrollable;
}

test.describe("conversation scroll-lock", () => {
  test("auto-follows new turns to the bottom", async ({ chat }) => {
    await chat.open();
    const scrollable = await fillUntilScrollable(chat);
    expect(scrollable, "thread never grew tall enough to scroll — assertion would be vacuous").toBeGreaterThan(0);

    // With scroll-lock on, the viewport rode each new turn down to the bottom.
    await expect.poll(() => chat.distanceFromBottom(), { timeout: 10_000 }).toBeLessThanOrEqual(AT_BOTTOM_PX);
    // The canonical signal: at the bottom, the scroll-to-bottom arrow is DISABLED
    // (assistant-ui hides it via `disabled:invisible`).
    await expect(chat.scrollToBottomButton()).toBeDisabled();
  });

  test("scrolling up releases the lock; the arrow re-engages it", async ({ chat }) => {
    await chat.open();
    const scrollable = await fillUntilScrollable(chat);
    expect(scrollable, "thread never grew tall enough to scroll").toBeGreaterThan(0);
    await expect.poll(() => chat.distanceFromBottom(), { timeout: 10_000 }).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // Scroll UP to the top. The lock releases — assert via the ARROW becoming enabled
    // (the UI's own "not at bottom" signal), which is deterministic regardless of how
    // many px the (variable-height) thread actually scrolled. A loose px check backs
    // it up: distance grew well past the at-bottom tolerance.
    await chat.viewport().evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
    await expect(chat.scrollToBottomButton()).toBeEnabled();
    await expect.poll(() => chat.distanceFromBottom(), { timeout: 5_000 }).toBeGreaterThan(AT_BOTTOM_PX);

    // Click the arrow — it re-engages the lock: the view returns to the bottom and the
    // arrow disables again.
    await chat.scrollToBottomButton().click();
    await expect.poll(() => chat.distanceFromBottom(), { timeout: 5_000 }).toBeLessThanOrEqual(AT_BOTTOM_PX);
    await expect(chat.scrollToBottomButton()).toBeDisabled();
  });
});
