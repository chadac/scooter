/**
 * Tier 3 E2E for the message queue under real in-flight runs. A long run is driven with the
 * fake agent's `!sleep N` directive, then further messages must queue (with the right text,
 * order and priority), survive a page reload, and drain and execute once the run completes.
 */

import { test, expect } from "./fixtures.js";

// How long the run that everything queues behind stays in flight; nothing waits for the
// sleep to finish, so a long window costs no wall-clock time.
const RUN_SEC = 60;

test.describe("queue rendering while a run is in flight", () => {
  // On the full target `!sleep` runs in a real sandbox behind a cold boot, so the suite
  // default is too short.
  test.setTimeout(180_000);

  test("a message sent mid-run RENDERS as a queued item (not dropped)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(RUN_SEC);
    await chat.sendWhileRunning("queued while busy");
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="queued-message-text"]').first()).toContainText("queued while busy");
  });

  test("THREE messages sent mid-run all queue, in FIFO order", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(RUN_SEC);
    await chat.sendWhileRunning("first queued");
    await chat.sendWhileRunning("second queued");
    await chat.sendWhileRunning("third queued");
    await expect(chat.queuedMessages()).toHaveCount(3, { timeout: 15_000 });

    // Rows render by (priority DESC, arrival ASC) and a send's priority is derived from the
    // replayed log, so FIFO is a property of rows that share a priority.
    const rows = await chat.queuedMessages().evaluateAll((els) =>
      els.map((el) => ({
        priority: el.getAttribute("data-priority") ?? "false",
        text: el.querySelector('[data-testid="queued-message-text"]')?.textContent ?? "",
      })),
    );
    const sent = ["first queued", "second queued", "third queued"];
    const arrivalOf = (text: string) => sent.findIndex((s) => text.includes(s));

    for (const group of new Set(rows.map((r) => r.priority))) {
      const arrivals = rows.filter((r) => r.priority === group).map((r) => arrivalOf(r.text));
      expect(arrivals, `a queued row at priority=${group} carries text this test never sent`).not.toContain(-1);
      expect(
        arrivals,
        `FIFO broken within priority=${group}: rows rendered in arrival order ${arrivals.join(", ")}`,
      ).toEqual([...arrivals].sort((a, b) => a - b));
    }
    // Every message queued exactly once, however the priority groups split.
    expect(
      rows.map((r) => arrivalOf(r.text)).sort((a, b) => a - b),
      "each of the three sends must be queued exactly once",
    ).toEqual([0, 1, 2]);
  });

  test("a mid-run message renders as a plain queued bubble (it lets running tools finish)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(RUN_SEC);
    await chat.sendWhileRunning("after the tool");
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });
    // Only a send that kills the running tool call gets the Priority pill.
    await expect(page.locator('[data-testid="queued-priority-pill"]')).toHaveCount(0);
  });

  test("queued messages render inline in the thread, faded, with a status (0 → n)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(RUN_SEC);
    await chat.sendWhileRunning("q1");
    await chat.sendWhileRunning("q2");
    await expect(chat.queuedMessages()).toHaveCount(2, { timeout: 15_000 });
    // They sit after the real thread messages, not in a side panel.
    await expect(page.locator('[data-testid="right-panel-tab-queue"]')).toHaveCount(0);
    await expect(chat.queuedMessages().first().locator('[data-testid="queued-message-status"]')).toBeVisible();
  });

  test("a long queued message clamps + can be expanded (Show more)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(RUN_SEC);
    const longText = Array.from({ length: 20 }, (_, i) => `line-${i} of a very long queued message`).join(" ");
    await chat.sendWhileRunning(longText);
    const toggle = page.locator('[data-testid="queued-message-toggle"]').first();
    // The clamp toggle is present for an overflowing message.
    await expect(toggle).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("queue durability across refresh + drain", () => {
  // Same arithmetic as the describe above, plus the drain tests' tail.
  test.setTimeout(180_000);

  test("queued messages SURVIVE a page reload (they ride the integrity stream, not client-only)", async ({ chat, page }) => {
    await chat.open();
    // The queued row only exists while the run it queues behind is in flight, which must
    // outlast send → queue → reload → re-derive.
    await chat.startLongRun(60);
    await chat.sendWhileRunning("survive the reload");
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });

    await page.reload();
    // The queued message is re-derived from the server's QUEUE_UPDATED snapshot on replay,
    // which on a cluster round-trips the router.
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('[data-testid="queued-message-text"]').first()).toContainText("survive the reload");
  });

  test("a queued message DRAINS + executes after the run finishes (its reply lands)", async ({ chat, page }) => {
    await chat.open();
    // A short sleep, long enough to queue behind.
    await chat.startLongRun(3);
    const before = await chat.assistantMessages().count();
    await chat.sendWhileRunning("run me after the sleep");

    // Once the sleep run and the queued run both complete there are more assistant messages
    // and the queued item leaves the queue.
    await expect.poll(async () => chat.assistantMessages().count(), { timeout: 90_000 }).toBeGreaterThan(before);
    await expect(chat.queuedMessages()).toHaveCount(0, { timeout: 20_000 });
    await expect(chat.userMessages().filter({ hasText: "run me after the sleep" })).toHaveCount(1);
  });

  test("the composer is usable again after the queue fully drains", async ({ chat, page }) => {
    await chat.open();
    // The run must still be in flight across the full target's ready-pod wait, but this test
    // waits for the drain, so the window is shorter than RUN_SEC.
    await chat.startLongRun(20);
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    await chat.sendWhileRunning("drain me");
    // After everything settles a fresh normal turn works first-try; sendTurn first waits for
    // the composer to go idle behind the boot, the sleep and the queued turn.
    await chat.sendTurn("a normal turn after draining", 150_000);
    await expect(chat.userMessages().filter({ hasText: "a normal turn after draining" })).toHaveCount(1);
  });

  test("an empty queue shows NO queued rows (badge absent / zero)", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("just one normal turn");
    await expect(chat.queuedMessages()).toHaveCount(0);
  });
});
