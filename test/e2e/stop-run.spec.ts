/**
 * Tier 3 E2E — the Stop button + thinking indicator (conversation interrupts).
 *
 * While a run is in flight the UI shows a thinking indicator (a single pulsing
 * dot) and a Stop button (RunStatusBar, gated on the log-derived
 * isRunning). Clicking Stop POSTs /conversations/:id/cancel, which ends the
 * running turn — the bridge kills the active tool call (a running shell), tells
 * goose to stop, and emits RUN_FINISHED{cancelled}. Afterwards a NEW prompt works.
 *
 * Drives the fake agent's "!<command>" directive with a long `sleep` so the turn
 * stays in flight long enough to observe + cancel — exercising the real kill path
 * (createTerminal -> localExec child -> SIGTERM on cancel).
 */

import { test, expect } from "./fixtures.js";

const bar = {
  root: '[data-testid="run-status-bar"]',
  stop: '[data-testid="stop-run"]',
  thinking: '[data-testid="thinking-indicator"]',
};

/** Budget for the FIRST turn of a fresh conversation.
 *
 *  It is the only turn that waits for a COLD sandbox pod (5-25s, longer when the CI node is
 *  short on CPU) before its exec even starts, so sendTurn's 45s default is a bet on the boot
 *  being quick rather than a measurement of what these tests assert. Observed on CI: "no
 *  spurious branch picker" failed at 50.3s on sendTurn's own reply-count poll — a boot that
 *  had not finished, with nothing wrong with the branch picker. */
const FIRST_TURN_MS = 90_000;

test.describe("Stop button + thinking indicator", () => {
  // Every test here opens a fresh conversation, so every one funds a cold sandbox boot
  // (FIRST_TURN_MS above) before it can assert anything. The 60s default cannot contain a
  // 90s first turn, so the ceiling has to clear it — 180s covers the boot plus the stop /
  // retry / follow-up phases the longer tests chain after it. Individual tests that need
  // more still set their own.
  test.beforeEach(() => test.setTimeout(180_000));
  test("a running turn shows the indicator + Stop; clicking Stop ends it, then a new prompt works", async ({
    chat,
    page,
  }) => {
    await chat.open();

    // A long-running turn: the fake agent runs `sleep 20` in the sandbox as a real
    // tool call, so the run stays in flight (RUN_STARTED, no RUN_FINISHED yet).
    await chat.send("!sleep 20");

    // The thinking indicator + Stop button appear while the run is in flight. The
    // indicator is now a single pulsing dot (no "working…" text, no per-message ●) —
    // assert its presence via the dot's aria-label.
    await expect(page.locator(bar.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(bar.thinking)).toBeVisible();
    await expect(page.locator(`${bar.thinking} [aria-label="Scooter is working"]`)).toBeVisible();
    await expect(page.locator(bar.stop)).toBeVisible();

    // Click Stop -> the run is cancelled (the shell is killed, goose told to stop).
    await page.locator(bar.stop).click();

    // The run ends: the status bar (gated on isRunning) goes away. This proves the
    // cancel reached the server and the terminal RUN_FINISHED flipped isRunning off
    // — WITHOUT waiting the full 20s the sleep would otherwise take.
    //
    // Use the app's OWN recovery affordance when the first click doesn't land. A cancel
    // has to reach the pod that owns the conversation, and on the full target that hop can
    // fail; the UI is designed for exactly this — RunStatusBar re-enables the button as
    // "Retry stop" and says "Stop didn't land — the run is still going". CI hit precisely
    // that state (the snapshot shows both), so the test sat waiting out a stop the app had
    // already reported as failed and was offering to repeat.
    //
    // Clicking the retry the UI is presenting is the real user path, so drive it. The
    // assertion is unchanged: the bar must reach 0. A stop that never works keeps the bar
    // up through every retry and still fails.
    await expect(async () => {
      if ((await page.locator(bar.root).count()) > 0) {
        await page.locator(bar.stop).click({ timeout: 5_000 }).catch(() => {});
      }
      await expect(page.locator(bar.root)).toHaveCount(0, { timeout: 15_000 });
    }).toPass({ timeout: 60_000 });

    // The conversation is usable again: a follow-up prompt runs to completion.
    // FIRST_TURN_MS: the stop above cancelled the in-flight exec, so this turn can be waiting
    // on the sandbox to come back rather than reusing a warm one.
    await chat.sendTurn("!echo after-stop", FIRST_TURN_MS);
    await expect(page.getByText(/after-stop/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test("the indicator is absent when the conversation is idle", async ({ chat, page }) => {
    await chat.open();
    // A quick turn that finishes fast — after it completes, no status bar.
    await chat.sendTurn("!echo hi", FIRST_TURN_MS);
    await expect(page.getByText(/hi/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(bar.root)).toHaveCount(0);
  });

  test("the COMPOSER shows a Stop button while a run is in flight (not just the bottom bar)", async ({ chat, page }) => {
    // The composer's native Stop is dead in the single-source model (thread.isRunning
    // is always false); it must be gated on OUR run state instead. Users look at the
    // composer, so the stop belongs there.
    await chat.open();
    await chat.send("!sleep 20");
    await expect(page.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 30_000 });
    // Clicking it stops the run (same cancel path as the bottom-bar Stop).
    await page.locator('[data-testid="composer-stop"]').click();
    await expect(page.locator('[data-testid="composer-stop"]')).toHaveCount(0, { timeout: 15_000 });
  });

  test("a running tool call shows a spinner; it clears when the tool finishes", async ({ chat, page }) => {
    // CLUSTER-HONEST BUDGET. At Tier-2 pace this test is arithmetic-bound, not
    // behaviour-bound: send → sandbox provision (~15-25s cold) → spinner → sleep 20 →
    // clear lands ~45-50s after send. The 60s default + a 30s clear-assertion budget
    // was written against the ~1s fake stack and fails on timing alone while the
    // spinner demonstrably clears (it passes whenever provisioning is warm).
    // 180s, matching the describe-level ceiling: this test would otherwise LOWER its own
    // budget below the one the cold boot needs.
    test.setTimeout(180_000);
    // A shell tool used to render as already "complete" the instant it started: the
    // bridge emitted a premature (empty) TOOL_CALL_RESULT on the args-only
    // in_progress update, so the folded part carried a result and assistant-ui
    // showed no spinner while e.g. `sleep 20` ran — the agent looked idle. The
    // running indicator must be visible while the tool runs and clear when it ends.
    await chat.open();
    await chat.send("!sleep 20");
    await expect(page.locator('[data-testid="provider-tool-running"]')).toBeVisible({ timeout: 30_000 });
    // When the sleep finishes the run ends and the spinner goes away. 60s, not 30:
    // the spinner appears when the tool call STREAMS, but the exec then waits for a
    // ready sandbox pod BEFORE the 20s sleep even starts — an instrumented throttled
    // run measured 12.1s of ready-pod wait + 19.7s of sleep = the clear landing ~32s
    // after the spinner, 2s past a 30s budget, with everything behaving correctly.
    await expect(page.locator('[data-testid="provider-tool-running"]')).toHaveCount(0, { timeout: 60_000 });
  });

  test("a fast tool call never shows a lingering spinner", async ({ chat, page }) => {
    // An instant command completes before we can meaningfully catch the spinner;
    // what matters is that after it finishes there is NO stuck running indicator.
    await chat.open();
    await chat.sendTurn("!echo quick", FIRST_TURN_MS);
    await expect(page.getByText(/quick/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="provider-tool-running"]')).toHaveCount(0);
  });

  test("no spurious branch picker (2/2) on a single-turn message", async ({ chat, page }) => {
    // The render pump's reset() used to collide with the composer's optimistic
    // append, making assistant-ui show a phantom "2 / 2" branch. There are no real
    // message branches in the single-source model — the picker must not appear.
    await chat.open();
    await chat.sendTurn("!echo one", FIRST_TURN_MS);
    await expect(page.getByText(/one/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".aui-branch-picker-root")).toHaveCount(0);
  });
});
