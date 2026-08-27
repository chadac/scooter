/**
 * Tier 3 E2E — CONCURRENCY: two viewers of the SAME conversation.
 *
 * Every prior spec drives ONE page. That structurally cannot reach the class of bug where two
 * clients of the same conversation diverge — which is what a user actually hits with a second tab
 * open, or a webhook/Slack driving the same thread while they watch it. The integrity stream is
 * supposed to make every viewer converge on the same log; this spec asserts that.
 *
 * Both pages are snapshotted and cross-compared, so a divergence names which surface disagreed.
 */

import { test, expect, Chat, snapshot, assertConsistent, type UiSnapshot } from "./fixtures.js";
import type { Page } from "@playwright/test";

/** Fields BOTH viewers of the same conversation must agree on once things settle. */
function sharedView(s: UiSnapshot) {
  return {
    userMessages: s.userMessages,
    assistantMessages: s.assistantMessages,
    toolCards: s.toolCards,
    interruptOpen: s.interruptOpen,
  };
}

async function bothSettled(a: Page, b: Page, when: string): Promise<[UiSnapshot, UiSnapshot]> {
  // ACTUALLY settle before snapshotting. This helper was named "settled" but only snapshotted,
  // which is what fails CI on `SIMULTANEOUS sends from both tabs`: the test's earlier polls wait
  // only for the USER messages to land in both tabs, so the assistant replies may still be
  // streaming. Tab A then reads one reply behind tab B (assistantMessages 2 vs 3, toolCards 2 vs 3)
  // and the "both tabs agree" comparison fails on a difference that resolves a moment later.
  //
  // Two conditions, in this order:
  //   1. neither tab has a run in flight — the run-status bar is gone on BOTH;
  //   2. the compared counts have STOPPED CHANGING and match.
  // (1) alone is not enough: a tab can be idle because its stream has not delivered the last reply
  // yet, not because there is nothing left to deliver.
  for (const p of [a, b]) {
    await expect(p.locator('[data-testid="run-status-bar"]'), `${when}: a run is still in flight`)
      .toHaveCount(0, { timeout: 45_000 });
  }
  await expect
    .poll(async () => {
      const [x, y] = [await snapshot(a), await snapshot(b)];
      return JSON.stringify(sharedView(x)) === JSON.stringify(sharedView(y));
    }, { timeout: 45_000, message: `${when}: the two tabs never converged on the same view` })
    .toBe(true);
  const sa = await snapshot(a);
  const sb = await snapshot(b);
  assertConsistent(sa, `${when} (page A)`);
  assertConsistent(sb, `${when} (page B)`);
  return [sa, sb];
}

test.describe("two tabs on the same conversation", () => {
  // completeTurn's default is 120s on the full target (it waits for a cold sandbox pod
  // before the exec, then for the run to END). The 60s suite ceiling cannot contain that,
  // and these tests chain several turns across two tabs. The individual test below that
  // already sets 180s keeps its own.
  test.beforeEach(() => test.setTimeout(300_000));

  test("a turn sent in tab A appears in tab B without any refresh", async ({ chat, page, context, baseURL }) => {
    await chat.open();
    await chat.completeTurn("first turn from tab A");
    const url = page.url();

    // Tab B opens the SAME conversation.
    const pageB = await context.newPage();
    await pageB.goto(url);
    const chatB = new Chat(pageB);
    await expect(chatB.input()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await snapshot(pageB)).userMessages, { timeout: 30_000 })
      .toBe(1);

    // A new turn in A must reach B live — no reload in B.
    await chat.completeTurn("second turn from tab A");
    await expect
      .poll(async () => (await snapshot(pageB)).userMessages, { timeout: 45_000 })
      .toBe(2);
    const [sa, sb] = await bothSettled(page, pageB, "after a turn in A");
    expect(sharedView(sb), "tab B must converge on tab A's view").toEqual(sharedView(sa));
    await pageB.close();
  });

  test("turns sent ALTERNATELY from both tabs converge to one consistent transcript", async ({ chat, page, context, baseURL }) => {
    await chat.open();
    await chat.completeTurn("opening turn");
    const url = page.url();
    const pageB = await context.newPage();
    await pageB.goto(url);
    const chatB = new Chat(pageB);
    await expect(chatB.input()).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await snapshot(pageB)).userMessages, { timeout: 30_000 }).toBe(1);

    // Alternate senders — each tab must see BOTH its own and the other's turns.
    await chat.completeTurn("turn from A");
    await expect.poll(async () => (await snapshot(pageB)).userMessages, { timeout: 45_000 }).toBe(2);
    await chatB.completeTurn("turn from B");
    await expect.poll(async () => (await snapshot(page)).userMessages, { timeout: 45_000 }).toBe(3);

    const [sa, sb] = await bothSettled(page, pageB, "after alternating turns");
    expect(sharedView(sb), "both tabs must show the same transcript").toEqual(sharedView(sa));
    await pageB.close();
  });

  test("a message QUEUED in tab A is visible in tab B (the queue is server-side, not client-only)", async ({ chat, page, context }) => {
    await chat.open();
    await chat.completeTurn("baseline before the shared queue");
    const url = page.url();
    const pageB = await context.newPage();
    await pageB.goto(url);
    const chatB = new Chat(pageB);
    await expect(chatB.input()).toBeVisible({ timeout: 20_000 });

    // A queues a message behind a long run; B must see it in ITS queue tab.
    await chat.send("!sleep 6");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    await chat.sendWhileRunning("queued in A, visible in B");
    await chatB.openQueueTab();
    await expect
      .poll(async () => (await snapshot(pageB)).queued.join("|"), { timeout: 45_000 })
      .toContain("queued in A, visible in B");

    assertConsistent(await snapshot(pageB), "queue visible in B");
    await pageB.close();
  });

  test("an INTERRUPT raised in one tab is answerable and settles in BOTH", async ({ chat, page, context }) => {
    await chat.open();
    await chat.completeTurn("baseline before the shared interrupt");
    const url = page.url();
    const pageB = await context.newPage();
    await pageB.goto(url);
    const chatB = new Chat(pageB);
    await expect(chatB.input()).toBeVisible({ timeout: 20_000 });

    await chat.send("?pick a color");
    // BOTH tabs must show the pending approval — it's conversation state, not tab state.
    await expect(page.locator('[data-testid="interrupt-panel"]')).toBeVisible({ timeout: 30_000 });
    await expect(pageB.locator('[data-testid="interrupt-panel"]')).toBeVisible({ timeout: 45_000 });

    // Answer in B; A must also clear (no phantom approval left behind).
    await pageB.locator('[data-testid="interrupt-option"]').filter({ hasText: /green/i }).click();
    await expect(pageB.locator('[data-testid="interrupt-panel"]')).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => (await snapshot(page)).interruptOpen, { timeout: 45_000 })
      .toBe(false);

    const [sa, sb] = await bothSettled(page, pageB, "after answering in B");
    expect(sa.interruptOpen, "tab A must not keep a phantom approval").toBe(false);
    expect(sharedView(sb), "both tabs converge after the answer").toEqual(sharedView(sa));
    await pageB.close();
  });

  test("SIMULTANEOUS sends from both tabs lose neither message", async ({ chat, page, context }) => {
    // Real end-to-end work (a run draining behind a queued turn) needs more than the 60s suite
    // default — the 90s polls below were otherwise silently capped by the TEST budget, so a slower
    // CI runner failed the test while the poll still had time left on paper.
    // 300s, matching the describe-level ceiling: at 180s this line would LOWER the budget
    // below what a 120s completeTurn plus those 90s polls needs.
    test.setTimeout(300_000);
    await chat.open();
    await chat.completeTurn("baseline before simultaneous sends");
    const url = page.url();
    const pageB = await context.newPage();
    await pageB.goto(url);
    const chatB = new Chat(pageB);
    await expect(chatB.input()).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await snapshot(pageB)).userMessages, { timeout: 30_000 }).toBe(1);

    // Fire both at once — one runs, the other must QUEUE, and neither may vanish.
    await Promise.all([
      chat.sendWhileRunning("simultaneous from A"),
      chatB.sendWhileRunning("simultaneous from B"),
    ]);

    // Both messages must eventually appear as real turns in BOTH tabs.
    for (const p of [page, pageB]) {
      await expect
        .poll(async () => p.locator(".aui-user-message-content").filter({ hasText: "simultaneous from A" }).count(), { timeout: 90_000 })
        .toBe(1);
      await expect
        .poll(async () => p.locator(".aui-user-message-content").filter({ hasText: "simultaneous from B" }).count(), { timeout: 90_000 })
        .toBe(1);
    }
    const [sa, sb] = await bothSettled(page, pageB, "after simultaneous sends");
    expect(sharedView(sb), "both tabs agree after a concurrent send race").toEqual(sharedView(sa));
    await pageB.close();
  });
});
