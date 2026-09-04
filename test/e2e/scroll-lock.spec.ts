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
    // 90s per turn, not sendTurn's 45s default. On the full target every turn execs in a
    // real sandbox and the FIRST one additionally waits for a cold pod (15-25s, longer
    // when the CI node is briefly starved of cpu) — the very first turn
    // of this fill timed out at 45s with assistantMessages still 1, failing both scroll
    // tests before either could measure anything. The loop exits as soon as the thread
    // is tall enough, so a larger ceiling costs no wall-clock time on a healthy run.
    await chat.sendTurn(
      `turn number ${i} — please review something moderately long so the thread grows`,
      90_000,
    );
    scrollable = await chat.scrollableHeight();
  }
  return scrollable;
}

test.describe("conversation scroll-lock", () => {
  // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). fillUntilScrollable sends up to
  // 12 sendTurns, and on the full target EVERY turn execs `echo` in a real sandbox:
  // the first turn funds a cold boot (≤25s) and each later turn costs ~5-8s (exec +
  // word-by-word streaming) — the fill alone is ~110s worst case, before the test's
  // own scroll assertions. The 60s suite default is arithmetic-bound; 360s funds the
  // fill plus the big-append/settle work with margin (the fill's first turn now has a
  // 90s ceiling for the cold boot, and a tall CI viewport can need several turns before
  // the thread is scrollable). The scroll assertions keep their tight budgets — they
  // measure the viewport, not the cluster.
  test.setTimeout(360_000);

  test("auto-follows new turns to the bottom", async ({ chat }) => {
    await chat.open();
    const scrollable = await fillUntilScrollable(chat);
    expect(scrollable, "thread never grew tall enough to scroll — assertion would be vacuous").toBeGreaterThan(0);

    // With scroll-lock on, the viewport rode each new turn down to the bottom.
    await chat.settleAtBottom();
    // The canonical signal: at the bottom, the scroll-to-bottom arrow is DISABLED
    // (assistant-ui hides it via `disabled:invisible`). Generous timeout — the store's
    // isAtBottom flag updates on a scroll event, which can trail the settle in slow CI.
    await expect(chat.scrollToBottomButton()).toBeDisabled({ timeout: 10_000 });
  });

  test("a BIG single-frame message does NOT break the auto-follow (the reported bug)", async ({ chat, page }) => {
    // The reported regression: when a long message appends in ONE layout frame (a big
    // user paste renders as one bubble instantly; a markdown code block / table reflows
    // as one unit — unlike word-by-word streamed text), scrollHeight jumps by far more
    // than assistant-ui's 1px bottom threshold while scrollTop is unchanged. Its handler
    // misreads that as "user scrolled up" and latches isAtBottom=false, so autoScroll
    // disengages and the view is stranded MANY viewports up — forcing a manual scroll.
    // (Measured pre-fix: ~3200px from bottom on a 665px viewport.) useStickToBottom must
    // keep it pinned across that jump.
    await chat.open();
    await fillUntilScrollable(chat);
    await chat.settleAtBottom();

    const viewportH = await chat.viewport().evaluate((el) => el.clientHeight);
    // A single message ~4 viewports tall. Newlines force real vertical growth (not one
    // wrapped line), so it's a genuine big single-frame append.
    const bigLines = Math.ceil((viewportH / 20) * 4);
    const huge = Array.from({ length: bigLines }, (_, i) => `line ${i} of a very long pasted block`).join("\n");

    await chat.send(huge);
    // The user bubble renders in one frame on send — wait until that big append landed
    // (scrollHeight grew past a viewport).
    await expect.poll(() => chat.scrollableHeight(), { timeout: 10_000 }).toBeGreaterThan(viewportH);

    // Assert on the PEAK distance across the settle window, not just the final value:
    // the library eventually crawls back to the bottom on its own (~1s of thrashing),
    // so a delayed one-shot check is vacuous. The BUG is the transient strand — pre-fix
    // this peaks in the THOUSANDS of px (~3300–4000 on a 665px viewport) while
    // it visibly bounces; with the fix it never leaves the bottom (peak ≤ a few px). A
    // threshold of one viewport height cleanly separates the two: fixed stays well
    // under it, broken blows way past.
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      peak = Math.max(peak, await chat.distanceFromBottom());
      await page.waitForTimeout(40);
    }
    expect(peak, "the view was stranded away from the bottom after a big append").toBeLessThan(viewportH);
    await expect(chat.scrollToBottomButton()).toBeDisabled({ timeout: 10_000 });
  });

  test("scrolling up releases the lock; the arrow re-engages it", async ({ chat, page }) => {
    await chat.open();
    const scrollable = await fillUntilScrollable(chat);
    expect(scrollable, "thread never grew tall enough to scroll").toBeGreaterThan(0);
    await chat.settleAtBottom();

    // Scroll UP to the top. The lock releases — assert via the ARROW becoming enabled
    // (the UI's own "not at bottom" signal), which is deterministic regardless of how
    // many px the (variable-height) thread actually scrolled. A loose px check backs
    // it up: distance grew well past the at-bottom tolerance.
    //
    // Re-issue the scroll INSIDE the poll: assistant-ui's useStickToBottom can yank the
    // viewport back down on the animation frame right after a single programmatic
    // scroll-up (it still believes it's pinned), collapsing distanceFromBottom to ~0
    // before our measurement — a one-shot scrollTo + poll then flakes. Scrolling up on
    // every poll tick wins the race deterministically: once the store latches
    // isAtBottom=false, the yank stops and the distance stays open.
    //
    // Gate the poll on the ARROW being enabled — the store's own isAtBottom=false
    // signal — NOT on distanceFromBottom alone. The `disabled` flag updates from a
    // SCROLL EVENT and can trail the measured position (same trailing-flag flake that
    // `settleAtBottom` documents, here in reverse): the poll could exit on a tick where
    // the viewport had physically scrolled up (distance > tolerance) but the store had
    // not yet processed the scroll event, so useStickToBottom yanked the view back down
    // and the arrow never enabled — `toBeEnabled()` on the next line then hung the full
    // timeout. The nightly ×5 caught this ~40% of the time (2/5 reps). Polling until the
    // arrow itself reports enabled ties the exit condition to the signal we assert on,
    // while the loose px check below backs it up.
    await expect
      .poll(
        async () => {
          await chat.viewport().evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
          return (await chat.scrollToBottomButton().isEnabled()) && (await chat.distanceFromBottom()) > AT_BOTTOM_PX;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // Wait for scroll events from the poll to settle. The poll's final iteration scrolled
    // to top=0, and assistant-ui's isAtBottom flag updates from scroll events asynchronously —
    // a late event can flip the flag after our poll has already exited and read isEnabled=true,
    // causing useStickToBottom to yank the viewport back to the bottom and hide the arrow
    // mid-click. The nightly ×5 caught this: iteration #3 hung for 6.1 minutes waiting for
    // the button to become visible again (it had become hidden right as the click started).
    //
    // Poll until the button is STABLY enabled: check that it remains enabled across multiple
    // samples with small delays between them. This is more robust than a fixed timeout —
    // it adapts to varying scroll-event processing speeds while still detecting if the
    // button flips back to disabled. The nightly ×5 revealed that 300ms wasn't enough
    // (iteration #2 at run 33846941314 failed with the button still disabled after 300ms).
    await expect
      .poll(
        async () => {
          // Sample the button state 3 times over 150ms total (50ms between samples).
          // If it stays enabled across all 3 checks, we're confident the scroll events
          // have settled and useStickToBottom won't yank the viewport back down.
          for (let i = 0; i < 3; i++) {
            if (!(await chat.scrollToBottomButton().isEnabled())) return false;
            if (i < 2) await page.waitForTimeout(50);
          }
          return true;
        },
        { timeout: 5_000 },
      )
      .toBe(true);

    // Re-verify the button is still enabled (this should now be deterministic).
    await expect(chat.scrollToBottomButton()).toBeEnabled();

    // Click the arrow — it re-engages the lock: the view returns to the bottom and the
    // arrow disables again.
    await chat.scrollToBottomButton().click();
    await expect.poll(() => chat.distanceFromBottom(), { timeout: 5_000 }).toBeLessThanOrEqual(AT_BOTTOM_PX);
    await expect(chat.scrollToBottomButton()).toBeDisabled();
  });
});
