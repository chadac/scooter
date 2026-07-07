/**
 * Tier 3 E2E — the Stop button + thinking indicator (conversation interrupts).
 *
 * While a run is in flight the UI shows a thinking indicator ("Scooter is
 * working…") and a Stop button (RunStatusBar, gated on the log-derived
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

test.describe("Stop button + thinking indicator", () => {
  test("a running turn shows the indicator + Stop; clicking Stop ends it, then a new prompt works", async ({
    chat,
    page,
  }) => {
    await chat.open();

    // A long-running turn: the fake agent runs `sleep 20` in the sandbox as a real
    // tool call, so the run stays in flight (RUN_STARTED, no RUN_FINISHED yet).
    await chat.send("!sleep 20");

    // The thinking indicator + Stop button appear while the run is in flight.
    await expect(page.locator(bar.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(bar.thinking)).toContainText(/working/i);
    await expect(page.locator(bar.stop)).toBeVisible();

    // Click Stop -> the run is cancelled (the shell is killed, goose told to stop).
    await page.locator(bar.stop).click();

    // The run ends: the status bar (gated on isRunning) goes away. This proves the
    // cancel reached the server and the terminal RUN_FINISHED flipped isRunning off
    // — WITHOUT waiting the full 20s the sleep would otherwise take.
    await expect(page.locator(bar.root)).toHaveCount(0, { timeout: 15_000 });

    // The conversation is usable again: a follow-up prompt runs to completion.
    await chat.sendTurn("!echo after-stop");
    await expect(page.getByText(/after-stop/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test("the indicator is absent when the conversation is idle", async ({ chat, page }) => {
    await chat.open();
    // A quick turn that finishes fast — after it completes, no status bar.
    await chat.sendTurn("!echo hi");
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

  test("no spurious branch picker (2/2) on a single-turn message", async ({ chat, page }) => {
    // The render pump's reset() used to collide with the composer's optimistic
    // append, making assistant-ui show a phantom "2 / 2" branch. There are no real
    // message branches in the single-source model — the picker must not appear.
    await chat.open();
    await chat.sendTurn("!echo one");
    await expect(page.getByText(/one/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".aui-branch-picker-root")).toHaveCount(0);
  });
});
