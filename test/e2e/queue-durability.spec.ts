/**
 * Tier 3 E2E — the message QUEUE renders + survives, under real in-flight runs.
 *
 * Targets the reported "messages sent while the agent is working don't show up in the queue" +
 * "queued messages vanish on refresh" reliability bugs. Drives a long in-flight run with the fake
 * agent's `!sleep N` directive, then sends more messages that MUST queue (render with the right text,
 * order, and priority), survive a page reload, and DRAIN + execute once the run completes.
 *
 * Uses the fake agent (deterministic). See fixtures: startLongRun / sendWhileRunning / queuedMessages.
 */

import { test, expect } from "./fixtures.js";

test.describe("queue rendering while a run is in flight", () => {
  // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). On the full target `!sleep 20`
  // runs in a REAL sandbox: the run-status bar appears as soon as the run starts, but
  // the reload test then pays open ~5s + queue asserts + reload + re-derive while the
  // sleep (behind a ≤25s cold boot) is still holding the run open — ~60s of expected
  // work at the 60s suite default. 180s funds every test here with margin; the
  // per-assert budgets are already generous (the queue itself is server-side state,
  // not gated on the sandbox).
  test.setTimeout(180_000);

  test("a message sent mid-run RENDERS as a queued item (not dropped)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(20);
    await chat.sendWhileRunning("queued while busy");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="queued-message-text"]').first()).toContainText("queued while busy");
  });

  test("THREE messages sent mid-run all queue, in FIFO order", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(20);
    await chat.sendWhileRunning("first queued");
    await chat.sendWhileRunning("second queued");
    await chat.sendWhileRunning("third queued");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(3, { timeout: 15_000 });
    const texts = (await page.locator('[data-testid="queued-message-text"]').allInnerTexts()).join(" | ");
    // FIFO order: first appears before second before third (no dotAll flag needed).
    expect(texts.indexOf("first queued")).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf("first queued")).toBeLessThan(texts.indexOf("second queued"));
    expect(texts.indexOf("second queued")).toBeLessThan(texts.indexOf("third queued"));
  });

  test("a mid-run message carries the PRIORITY pill (it preempts the running turn)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(20);
    await chat.sendWhileRunning("urgent");
    await chat.openQueueTab();
    // The UI marks a send-while-running as priority (runIsActive → 10) — the pill must render.
    await expect(page.locator('[data-testid="queued-priority-pill"]').first()).toBeVisible({ timeout: 15_000 });
  });

  test("the Queue tab BADGE counts queued messages (0 → n)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(20);
    await chat.sendWhileRunning("q1");
    await chat.sendWhileRunning("q2");
    const badge = page.locator('[data-testid="right-panel-badge-queue"]');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText(/2/, { timeout: 15_000 });
  });

  test("a long queued message clamps + can be expanded (Show more)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(20);
    const longText = Array.from({ length: 20 }, (_, i) => `line-${i} of a very long queued message`).join(" ");
    await chat.sendWhileRunning(longText);
    await chat.openQueueTab();
    const toggle = page.locator('[data-testid="queued-message-toggle"]').first();
    // The clamp toggle is present for an overflowing message.
    await expect(toggle).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("queue durability across refresh + drain", () => {
  // CLUSTER-HONEST BUDGET — same arithmetic as the describe above, plus the drain
  // tests' tail: boot ≤25s + sleep 3s + the queued turn (exec + streamed reply ~10s)
  // + a follow-up turn ≈ 70s of expected work on the worst test. 180s with margin.
  test.setTimeout(180_000);

  test("queued messages SURVIVE a page reload (they ride the integrity stream, not client-only)", async ({ chat, page }) => {
    await chat.open();
    // 60s, not 20: the queued row only exists while the run it is queued BEHIND is still
    // in flight, and this test has to get through send → queue → reload → re-derive before
    // reading it. On the full target the exec waits for a ready sandbox pod before the
    // sleep even starts, so a 20s run can be over by the time the post-reload poll looks —
    // the queue has legitimately drained and the assertion sees 0 (observed on CI: 44
    // polls, 0 elements). Nothing waits for this sleep to finish (the test ends mid-run and
    // cleanState cancels it), so the longer run costs no wall-clock time.
    await chat.startLongRun(60);
    await chat.sendWhileRunning("survive the reload");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });

    await page.reload();
    await chat.openQueueTab();
    // The queued message is re-derived from the server's QUEUE_UPDATED snapshot on replay.
    // 60s, not 20: the reload re-derives from the integrity log, which on a cluster round-
    // trips the router to the owning pod.
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('[data-testid="queued-message-text"]').first()).toContainText("survive the reload");
  });

  test("a queued message DRAINS + executes after the run finishes (its reply lands)", async ({ chat, page }) => {
    await chat.open();
    // A short sleep so the test doesn't wait the full 20s — long enough to queue behind.
    await chat.send("!sleep 3");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    const before = await chat.assistantMessages().count();
    await chat.sendWhileRunning("run me after the sleep");

    // Once the sleep run + the queued run both complete, there are MORE assistant messages,
    // and the queued item leaves the queue. 90s, not 45: on the full target the sleep-3
    // run first waits for a ready sandbox pod (≤25s cold), then the queued turn runs its
    // own exec + streamed reply (~10s) — the reply lands ~40s after the send when cold,
    // which leaves a 45s budget no headroom under CI CPU pressure.
    await expect.poll(async () => chat.assistantMessages().count(), { timeout: 90_000 }).toBeGreaterThan(before);
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(0, { timeout: 20_000 });
    await expect(chat.userMessages().filter({ hasText: "run me after the sleep" })).toHaveCount(1);
  });

  test("the composer is usable again after the queue fully drains", async ({ chat, page }) => {
    await chat.open();
    await chat.send("!sleep 3");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    await chat.sendWhileRunning("drain me");
    // After everything settles, a fresh normal turn works first-try (no wedge). 90s:
    // sendTurn first waits for the composer to go idle — behind the cold-boot + sleep +
    // queued-turn tail (~40s on the full target, same arithmetic as the drain test).
    await chat.sendTurn("a normal turn after draining", 90_000);
    await expect(chat.userMessages().filter({ hasText: "a normal turn after draining" })).toHaveCount(1);
  });

  test("an empty queue shows NO queued rows (badge absent / zero)", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("just one normal turn");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(0);
  });
});
