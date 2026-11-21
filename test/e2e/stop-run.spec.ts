/**
 * Tier 3 E2E for the Stop button and thinking indicator. While a run is in flight the UI
 * shows a pulsing dot and a Stop button (RunStatusBar, gated on the log-derived isRunning);
 * clicking Stop POSTs /conversations/:id/cancel, which kills the active tool call, tells
 * goose to stop, and emits RUN_FINISHED{cancelled}. The fake agent's "!<command>" directive
 * with a long `sleep` keeps the turn in flight long enough to observe and cancel.
 */

import { test, expect } from "./fixtures.js";

const bar = {
  root: '[data-testid="run-status-bar"]',
  stop: '[data-testid="stop-run"]',
  thinking: '[data-testid="thinking-indicator"]',
};

/** Budget for the first turn of a fresh conversation, the only one that waits for a cold
 *  sandbox pod before its exec starts. */
const FIRST_TURN_MS = 90_000;

test.describe("Stop button + thinking indicator", () => {
  // Every test here opens a fresh conversation and funds a cold sandbox boot, so the ceiling
  // must clear FIRST_TURN_MS plus the phases chained after it.
  test.beforeEach(() => test.setTimeout(180_000));
  test("a running turn shows the indicator + Stop; clicking Stop ends it, then a new prompt works", async ({
    chat,
    page,
  }) => {
    await chat.open();

    // A long-running turn: the fake agent runs `sleep 20` in the sandbox as a real tool call.
    await chat.send("!sleep 20");

    // The thinking indicator and Stop button appear while the run is in flight; this is the
    // first assertion after a cold send, so the sandbox boot is inside its budget.
    await expect(page.locator(bar.root)).toBeVisible({ timeout: FIRST_TURN_MS });
    await expect(page.locator(bar.thinking)).toBeVisible();
    await expect(page.locator(`${bar.thinking} [aria-label="Scooter is working"]`)).toBeVisible();
    await expect(page.locator(bar.stop)).toBeVisible();

    // Click Stop: the run is cancelled.
    await page.locator(bar.stop).click();

    // The run ends and the status bar goes away without waiting out the sleep; when the
    // first click does not land, drive the "Retry stop" affordance the UI offers, since a
    // stop that never works keeps the bar up through every retry.
    await expect(async () => {
      if ((await page.locator(bar.root).count()) > 0) {
        await page.locator(bar.stop).click({ timeout: 5_000 }).catch(() => {});
      }
      await expect(page.locator(bar.root)).toHaveCount(0, { timeout: 15_000 });
    }).toPass({ timeout: 60_000 });

    // The conversation is usable again; the stop cancelled the exec, so this turn may wait
    // on the sandbox to come back.
    await chat.sendTurn("!echo after-stop", FIRST_TURN_MS);
    await expect(page.getByText(/after-stop/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test("the indicator is absent when the conversation is idle", async ({ chat, page }) => {
    await chat.open();
    // After a quick turn completes there is no status bar.
    await chat.sendTurn("!echo hi", FIRST_TURN_MS);
    await expect(page.getByText(/hi/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(bar.root)).toHaveCount(0);
  });

  test("the COMPOSER shows a Stop button while a run is in flight (not just the bottom bar)", async ({ chat, page }) => {
    // The composer's native Stop is dead in the single-source model, so it must be gated on
    // our run state.
    await chat.open();
    await chat.send("!sleep 20");
    // The first assertion after a cold send.
    await expect(page.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: FIRST_TURN_MS });
    // Clicking it stops the run (same cancel path as the bottom-bar Stop).
    await page.locator('[data-testid="composer-stop"]').click();
    await expect(page.locator('[data-testid="composer-stop"]')).toHaveCount(0, { timeout: 15_000 });
  });

  test("a draft typed mid-run turns the composer's Stop back into Send", async ({ chat, page }) => {
    // Phones need a tappable Send to queue mid-run.
    await chat.open();
    await chat.send("!sleep 20");
    const stop = page.locator('[data-testid="composer-stop"]');
    const send = page.locator('.aui-composer-send');
    await expect(stop).toBeVisible({ timeout: FIRST_TURN_MS });
    const input = page.getByLabel("Message input");
    await input.fill("next one");
    await expect(send).toBeVisible();
    await expect(stop).toHaveCount(0);
    // The run bar's Stop is still offered while drafting.
    await expect(page.locator(bar.stop)).toBeVisible();
    await input.fill("");
    await expect(stop).toBeVisible();
  });

  test("a running tool call shows a spinner; it clears when the tool finishes", async ({ chat, page }) => {
    // The ceiling must clear the cold boot plus the 20s sleep before the spinner clears.
    test.setTimeout(180_000);
    // The running indicator must be visible while the tool runs and clear when it ends.
    await chat.open();
    await chat.send("!sleep 20");
    // The first assertion after a cold send.
    await expect(page.locator('[data-testid="provider-tool-running"]')).toBeVisible({ timeout: FIRST_TURN_MS });
    // The exec waits for a ready sandbox pod before the 20s sleep even starts, so the clear
    // needs more than 30s.
    await expect(page.locator('[data-testid="provider-tool-running"]')).toHaveCount(0, { timeout: 60_000 });
  });

  test("a fast tool call never shows a lingering spinner", async ({ chat, page }) => {
    // An instant command completes before the spinner can be caught; what matters is no
    // stuck indicator afterwards.
    await chat.open();
    await chat.sendTurn("!echo quick", FIRST_TURN_MS);
    await expect(page.getByText(/quick/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="provider-tool-running"]')).toHaveCount(0);
  });

  test("no spurious branch picker (2/2) on a single-turn message", async ({ chat, page }) => {
    // There are no real message branches in the single-source model, so the picker must not appear.
    await chat.open();
    await chat.sendTurn("!echo one", FIRST_TURN_MS);
    await expect(page.getByText(/one/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".aui-branch-picker-root")).toHaveCount(0);
  });
});
