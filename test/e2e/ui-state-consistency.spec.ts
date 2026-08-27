/**
 * Tier 3 E2E — WHOLE-UI STATE CONSISTENCY.
 *
 * The lesson from the first coverage pass: 28 tests asserting ONE fact each surfaced only ONE bug.
 * Real UI unreliability is CROSS-COMPONENT DIVERGENCE — the thread, the queue, the run-status bar,
 * the badges, the right panel and the sidebar disagreeing about the same instant. A single-fact test
 * walks straight past that.
 *
 * So every test here snapshots EVERY surface after EVERY step (`snapshot`) and asserts the
 * invariants that must hold BETWEEN components (`assertConsistent`) — plus, where it matters, that
 * the DOM still agrees with the SERVER (`assertMatchesServer`). A failure names the exact moment and
 * the exact pair of components that diverged.
 */

import { test, expect, snapshot, assertConsistent, assertMatchesServer, checkpoint, type UiSnapshot } from "./fixtures.js";
import type { Page } from "@playwright/test";

/** Snapshot + assert every invariant, and hand back the snapshot for step-specific assertions. */
async function step(page: Page, when: string): Promise<UiSnapshot> {
  // checkpoint = snapshot + screenshot (when UI_SHOTS=1) + the cross-component invariants.
  return checkpoint(page, when);
}

test.describe("whole-UI consistency through a normal turn", () => {
  test("every surface stays mutually consistent across idle → running → replied", async ({ chat, page, request, baseURL }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). On the full target the `!sleep 3`
    // exec waits for a ready sandbox pod first (5-25s measured), so the run lasts up to
    // ~30s; add open + the multi-surface snapshots and the worst case brushes the 60s
    // default on arithmetic alone.
    test.setTimeout(120_000);
    await chat.open();
    const idle = await step(page, "after open");
    expect(idle.running, "a fresh conversation must not claim to be running").toBe(false);
    expect(idle.queued, "a fresh conversation must have an empty queue").toEqual([]);
    expect(idle.interruptOpen, "a fresh conversation must have no interrupt").toBe(false);
    expect(idle.runError, "a fresh conversation must have no error").toBeNull();

    // RUNNING: the run bar is up, the composer offers Stop (not Send), nothing else changed state.
    await chat.send("!sleep 3");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    const running = await step(page, "while running");
    expect(running.running).toBe(true);
    expect(running.composerStop, "the composer must offer Stop while running").toBe(true);
    expect(running.runError, "a healthy run must not show an error").toBeNull();
    expect(running.userMessages, "the user's message renders immediately").toBeGreaterThan(idle.userMessages);

    // REPLIED: back to a fully idle, consistent state — no residue anywhere.
    await expect.poll(async () => (await snapshot(page)).running, { timeout: 45_000 }).toBe(false);
    const done = await step(page, "after the reply");
    expect(done.composerSendable, "the composer must return to Send when idle").toBe(true);
    expect(done.queued, "the queue must be empty after the run drains").toEqual([]);
    expect(done.assistantMessages, "the reply landed").toBeGreaterThan(idle.assistantMessages);
    expect(done.runError, "a successful run leaves no error behind").toBeNull();
    await assertMatchesServer(page, request, baseURL, "after the reply");
  });

  test("consistency holds at EVERY step of an 8-turn conversation (not just at the end)", async ({ chat, page, request, baseURL }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). EVERY fake-agent turn runs a real
    // exec (a plain message becomes `echo <text>`), so on the full target the first turn
    // waits for the sandbox (~30s worst) and each warm turn still costs ~5-10s of exec +
    // streaming + the per-step snapshot: 30 + 7 × 10 ≈ 100s of legitimate work against a
    // 60s default.
    test.setTimeout(240_000);
    await chat.open();
    for (let i = 1; i <= 8; i++) {
      await chat.sendTurn(`consistency turn ${i}`);
      // sendTurn returns when the reply TEXT lands; the run's terminal event trails it. Wait for the
      // run to actually end before asserting the between-turns idle state (otherwise we race it).
      await chat.waitForIdle();
      const s = await step(page, `after turn ${i}`);
      // Counts advance in lockstep — a divergence here is a dropped or duplicated message.
      expect(s.userMessages, `turn ${i}: user message count`).toBe(i);
      expect(s.assistantMessages, `turn ${i}: assistant message count`).toBe(i);
      // Between turns the app is fully idle with no residue on ANY surface.
      expect(s.running, `turn ${i}: still running between turns`).toBe(false);
      expect(s.composerSendable, `turn ${i}: composer not sendable between turns`).toBe(true);
      expect(s.queued, `turn ${i}: stale queue rows between turns`).toEqual([]);
      expect(s.runError, `turn ${i}: stale error between turns`).toBeNull();
      expect(s.interruptOpen, `turn ${i}: stale interrupt between turns`).toBe(false);
      expect(s.lastUserText, `turn ${i}: the newest message is the one just sent`).toContain(`consistency turn ${i}`);
    }
    await assertMatchesServer(page, request, baseURL, "after 8 turns");
  });
});

test.describe("whole-UI consistency around the QUEUE", () => {
  test("queueing keeps thread, queue, badge, run-state and composer mutually consistent", async ({ chat, page }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). startLongRun's 30s run-bar budget
    // plus two sendWhileRunning retry loops (up to 10s each) plus three whole-UI
    // snapshots leave no headroom inside the 60s default once the sandbox wait
    // (5-25s) stretches the timeline.
    test.setTimeout(120_000);
    await chat.open();
    await chat.startLongRun(20);
    const before = await step(page, "long run started");
    expect(before.running).toBe(true);

    await chat.sendWhileRunning("alpha");
    await chat.openQueueTab();
    const one = await step(page, "one message queued");
    // The row's innerText includes the "PRIORITY" pill, so assert the message text is CONTAINED
    // in the row rather than equal to it.
    expect(one.queued.join("|"), "the queued text must render in the queue").toContain("alpha");
    expect(one.running, "queueing must not end the in-flight run").toBe(true);
    expect(one.userMessages, "a QUEUED message must not yet appear as a thread turn").toBe(before.userMessages);

    await chat.sendWhileRunning("beta");
    const two = await step(page, "two messages queued");
    expect(two.queued.length, "both queued rows render").toBe(2);
    // assertConsistent already proved badge === rows; assert the ORDER explicitly.
    expect(two.queued.join("|"), "FIFO order").toMatch(/alpha.*beta/);
    expect(two.running, "still running with two queued").toBe(true);
  });

  test("the queue DRAINS into the thread with counts conserved (nothing lost, nothing duplicated)", async ({ chat, page, request, baseURL }) => {
    // A 60s wait inside the 60s suite default leaves ZERO headroom — the test dies at the same
    // moment its own poll would have. Give this one a budget larger than the work it waits on.
    test.setTimeout(180_000);
    await chat.open();
    await chat.send("!sleep 3");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    const start = await step(page, "run started");
    await chat.sendWhileRunning("drains into the thread");
    // The queued ROWS only mount while the Queue tab is selected — open it before reading them.
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 20_000 });
    const queued = await step(page, "queued");
    expect(queued.queued.join("|")).toContain("drains into the thread");

    // Conservation: the queued message must LEAVE the queue and ARRIVE in the thread — exactly once.
    await expect.poll(async () => (await snapshot(page)).queued.length, { timeout: 60_000 }).toBe(0);
    await expect.poll(async () => (await snapshot(page)).running, { timeout: 60_000 }).toBe(false);
    const end = await step(page, "after the drain");
    expect(end.userMessages, "both the original and the queued message are thread turns")
      .toBe(start.userMessages + 1);
    expect(
      await page.locator('.aui-user-message-content').filter({ hasText: "drains into the thread" }).count(),
      "the drained message appears EXACTLY once (not duplicated by the optimistic row)",
    ).toBe(1);
    await assertMatchesServer(page, request, baseURL, "after the drain");
  });

  test("a reload mid-queue preserves EVERY surface, not just the queue rows", async ({ chat, page, request, baseURL }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75): reload + the 30s re-derive poll on
    // top of a run whose exec first waits for the sandbox (5-25s) exceeds the 60s default.
    test.setTimeout(120_000);
    await chat.open();
    // 20s, not 6: the test asserts `running === true` AFTER the reload, so the run must
    // outlive open→send→queue→snapshot→reload→re-derive. On the fast stack that window is
    // a few seconds; on the full target the reload + queue re-poll alone can take ~10-15s
    // while the sandbox wait before the sleep is as little as ~5s — a 6s sleep can END
    // before the post-reload snapshot, failing the assertion with everything healthy.
    // Nothing waits for this sleep to finish (the test ends mid-run; cleanState cancels
    // it), so the longer sleep costs no wall-clock time.
    await chat.send("!sleep 20");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    await chat.sendWhileRunning("survives with full state");
    await chat.openQueueTab();
    const pre = await step(page, "before reload");

    await page.reload();
    await chat.openQueueTab();
    await expect.poll(async () => (await snapshot(page)).queued.length, { timeout: 30_000 }).toBe(1);
    const post = await step(page, "after reload");
    // The WHOLE state re-derived, not just the row: thread counts, queue contents, run state.
    expect(post.queued, "queued text survived").toEqual(pre.queued);
    expect(post.userMessages, "thread turns survived the reload").toBe(pre.userMessages);
    expect(post.running, "the in-flight run is still reflected after the reload").toBe(true);
    await assertMatchesServer(page, request, baseURL, "after reload");
  });
});

test.describe("whole-UI consistency around INTERRUPTS", () => {
  test("an interrupt leaves every OTHER surface coherent (panel, badge, run state, composer)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator('[data-testid="interrupt-panel"]')).toBeVisible({ timeout: 30_000 });
    const s = await step(page, "interrupt pending");
    expect(s.interruptOpen).toBe(true);
    expect(s.interruptOptions, "the interrupt is answerable").toBe(3);
    expect(s.panelVisible, "the right panel hosts the interrupt").toBe(true);
    expect(s.selectedTab, "the panel auto-focuses Approvals").toBe("right-panel-tab-approvals");
    expect(s.runError, "a pending approval is not an error").toBeNull();
  });

  test("answering an interrupt returns EVERY surface to a clean state", async ({ chat, page, request, baseURL }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator('[data-testid="interrupt-panel"]')).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="interrupt-option"]').filter({ hasText: /green/i }).click();
    await expect(page.getByText(/you picked: green/i).first()).toBeVisible({ timeout: 30_000 });

    await expect.poll(async () => (await snapshot(page)).running, { timeout: 45_000 }).toBe(false);
    const s = await step(page, "after answering");
    expect(s.interruptOpen, "the panel closes once answered").toBe(false);
    expect(s.interruptOptions, "no orphaned options linger").toBe(0);
    expect(s.approvalsBadge, "the approvals badge clears").toBeNull();
    expect(s.composerSendable, "the composer is usable again").toBe(true);
    expect(s.runError, "answering is not an error").toBeNull();
    await assertMatchesServer(page, request, baseURL, "after answering");
  });
});
