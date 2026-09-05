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

    // Release the lock by scrolling up with a REAL WHEEL GESTURE, not a programmatic
    // scrollTo. This is the fix for a flake that survived every timing-window tweak
    // (300ms → 150ms → 400ms stability sampling): the root cause was never the sampling
    // window, it was scrollTo. assistant-ui's useStickToBottom only DURABLY releases the
    // lock on a genuine user scroll gesture (wheel/touch) — that sets its internal
    // "escaped from lock" flag, which survives the content/resize frames that follow. A
    // programmatic scrollTo moves scrollTop and fires a scroll event but leaves that flag
    // UNSET, so the library re-pins the viewport to the bottom on the very next frame and
    // re-disables the arrow. That re-pin is the whole flake: the poll would catch the
    // arrow enabled for one tick, then the view got yanked back down before/while we
    // asserted (nightly ×5: ~40% of reps; run 33971490289 flake-focus: 2/20 reps).
    //
    // Wheel up on each poll tick until the arrow reports enabled AND the view sits above
    // the at-bottom tolerance. Re-wheeling each tick wins the initial race if the first
    // gesture lands mid-animation; once the escape flag latches the library stops
    // re-pinning, so the enabled state is then steady with no yank-back.
    const box = await chat.viewport().boundingBox();
    expect(box, "thread viewport has no bounding box").not.toBeNull();
    const wheelX = box!.x + box!.width / 2;
    const wheelY = box!.y + box!.height / 2;
    // Wheel by well more than the scrollable height so we reach the top even on a tall
    // thread; a floor keeps it a decisive gesture on a short one.
    const wheelDelta = Math.max(600, scrollable);
    await expect
      .poll(
        async () => {
          await page.mouse.move(wheelX, wheelY);
          await page.mouse.wheel(0, -wheelDelta);
          return (await chat.scrollToBottomButton().isEnabled()) && (await chat.distanceFromBottom()) > AT_BOTTOM_PX;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // The wheel gesture escaped the lock durably, so the enabled state is steady — no
    // stability-sampling window is needed (that was compensating for scrollTo's re-pin).
    // A plain re-assert is deterministic now: the arrow stays enabled until we click it.
    await expect(chat.scrollToBottomButton()).toBeEnabled();

    // Click the arrow — it re-engages the lock: the view returns to the bottom and the
    // arrow disables again.
    await chat.scrollToBottomButton().click();
    await expect.poll(() => chat.distanceFromBottom(), { timeout: 5_000 }).toBeLessThanOrEqual(AT_BOTTOM_PX);
    await expect(chat.scrollToBottomButton()).toBeDisabled();
  });
});
