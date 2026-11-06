/**
 * Tier 3 E2E for whole-UI state consistency. Real UI unreliability is cross-component
 * divergence (the thread, the queue, the run-status bar, the badges, the right panel and the
 * sidebar disagreeing about the same instant), so every test here snapshots every surface
 * after every step and asserts the invariants that must hold between components, plus,
 * where it matters, that the DOM still agrees with the server.
 */

import { test, expect, snapshot, assertConsistent, assertMatchesServer, checkpoint, type UiSnapshot } from "./fixtures.js";
import type { Page } from "@playwright/test";

/** Snapshot + assert every invariant, and hand back the snapshot for step-specific assertions. */
async function step(page: Page, when: string): Promise<UiSnapshot> {
  return checkpoint(page, when);
}

test.describe("whole-UI consistency through a normal turn", () => {
  test("every surface stays mutually consistent across idle → running → replied", async ({ chat, page, request, baseURL }) => {
    // On the full target the exec waits for a ready sandbox pod first, so the run alone can take ~30s.
    test.setTimeout(120_000);
    await chat.open();
    const idle = await step(page, "after open");
    expect(idle.running, "a fresh conversation must not claim to be running").toBe(false);
    expect(idle.queued, "a fresh conversation must have an empty queue").toEqual([]);
    expect(idle.interruptOpen, "a fresh conversation must have no interrupt").toBe(false);
    expect(idle.runError, "a fresh conversation must have no error").toBeNull();

    // Running: the run bar is up, the composer offers Stop, nothing else changed state.
    // A 20s sleep keeps the run in flight across the full target's ready-pod wait, so the
    // run bar is actually visible when the assertion polls.
    await chat.startLongRun(20);
    // The run bar becoming visible does not guarantee the user message has rendered yet, so
    // poll for its text before snapshotting.
    await expect
      .poll(
        async () => {
          const userMessages = page.locator('.aui-user-message-content');
          // textContent, not innerText: content-visibility:auto bubbles off-screen have an empty innerText.
          const lastText = (await userMessages.last().textContent().catch(() => "")) ?? "";
          return lastText.includes("!sleep 20");
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const running = await step(page, "while running");
    expect(running.running).toBe(true);
    expect(running.composerStop, "the composer must offer Stop while running").toBe(true);
    expect(running.runError, "a healthy run must not show an error").toBeNull();
    expect(running.userMessages, "the user's message renders immediately").toBeGreaterThan(idle.userMessages);

    // Replied: back to a fully idle, consistent state with no residue anywhere.
    // The 20s sleep may only just have begun when the bar appears, so the run can still owe
    // ~20s plus the reply.
    await expect.poll(async () => (await snapshot(page)).running, { timeout: 60_000 }).toBe(false);
    const done = await step(page, "after the reply");
    expect(done.composerSendable, "the composer must return to Send when idle").toBe(true);
    expect(done.queued, "the queue must be empty after the run drains").toEqual([]);
    expect(done.assistantMessages, "the reply landed").toBeGreaterThan(idle.assistantMessages);
    expect(done.runError, "a successful run leaves no error behind").toBeNull();
    await assertMatchesServer(page, request, baseURL, "after the reply");
  });

  test("consistency holds at EVERY step of an 8-turn conversation (not just at the end)", async ({ chat, page, request, baseURL }) => {
    // Every fake-agent turn runs a real exec, so on the full target eight turns cost well
    // over the 60s default.
    test.setTimeout(240_000);
    await chat.open();
    for (let i = 1; i <= 8; i++) {
      await chat.sendTurn(`consistency turn ${i}`);
      // sendTurn returns when the reply text lands; wait for the run to actually end before
      // asserting the idle state.
      await chat.waitForIdle();
      // Poll for the last user message's text before snapshotting, since the element can mount
      // before its text; read textContent, since an off-screen content-visibility:auto bubble
      // (the thread outgrows the viewport by turn ~7) has an empty innerText.
      await expect
        .poll(
          async () => {
            const userMessages = page.locator('.aui-user-message-content');
            const count = await userMessages.count();
            if (count < i) return false;
            const lastText = (await userMessages.nth(count - 1).textContent().catch(() => "")) ?? "";
            return lastText.includes(`consistency turn ${i}`);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      const s = await step(page, `after turn ${i}`);
      // Counts advance in lockstep; a divergence here is a dropped or duplicated message.
      expect(s.userMessages, `turn ${i}: user message count`).toBe(i);
      expect(s.assistantMessages, `turn ${i}: assistant message count`).toBe(i);
      // Between turns the app is fully idle with no residue on any surface.
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
    // startLongRun's run-bar budget plus two sendWhileRunning retry loops plus three
    // snapshots exceed the 60s default once the sandbox wait stretches the timeline.
    test.setTimeout(120_000);
    await chat.open();
    await chat.startLongRun(20);
    const before = await step(page, "long run started");
    expect(before.running).toBe(true);

    await chat.sendWhileRunning("alpha");
    const one = await step(page, "one message queued");
    // The row's innerText includes the "PRIORITY" pill, so assert containment rather than equality.
    expect(one.queued.join("|"), "the queued text must render in the queue").toContain("alpha");
    expect(one.running, "queueing must not end the in-flight run").toBe(true);
    expect(one.userMessages, "a QUEUED message must not yet appear as a thread turn").toBe(before.userMessages);

    await chat.sendWhileRunning("beta");
    const two = await step(page, "two messages queued");
    expect(two.queued.length, "both queued rows render").toBe(2);
    // Both messages queued is the invariant; their relative order depends on a priority
    // derived from the replayed log, and queue-durability.spec.ts owns the FIFO property.
    expect(two.queued.join("|"), "alpha is still queued").toContain("alpha");
    expect(two.queued.join("|"), "beta is queued").toContain("beta");
    expect(two.running, "still running with two queued").toBe(true);
  });

  test("the queue DRAINS into the thread with counts conserved (nothing lost, nothing duplicated)", async ({ chat, page, request, baseURL }) => {
    // A 60s wait inside the 60s suite default leaves no headroom.
    test.setTimeout(180_000);
    await chat.open();
    // A 20s sleep keeps the run in flight across the queueing window on the full target,
    // where the exec first waits for a ready pod.
    await chat.startLongRun(20);
    const start = await step(page, "run started");
    await chat.sendWhileRunning("drains into the thread");
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 20_000 });
    const queued = await step(page, "queued");
    expect(queued.queued.join("|")).toContain("drains into the thread");

    // Conservation: the queued message must leave the queue and arrive in the thread exactly once.
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
    // Reload plus the re-derive poll on top of a run whose exec first waits for the sandbox
    // exceeds the 60s default.
    test.setTimeout(120_000);
    await chat.open();
    // The run must outlive open→send→queue→snapshot→reload→re-derive, and nothing waits for
    // the sleep to finish.
    await chat.startLongRun(60);
    await chat.sendWhileRunning("survives with full state");
    const pre = await step(page, "before reload");

    await page.reload();
    // The reload re-derives the conversation from the integrity log, which on a cluster
    // round-trips the router to the owning pod.
    // A pod restart mid-test kills the run this asserts on, and its recovery prose can land
    // in the thread or in the queue itself, so skip only on that marker.
    const RESTART = /this conversation was interrupted by a restart/i;
    const restarted = async () => {
      if ((await page.getByText(RESTART).count()) > 0) return true;
      return (await snapshot(page)).queued.some((q) => RESTART.test(q));
    };
    // A row that is ours, not the platform's recovery message.
    const sawOurRow = async () =>
      (await snapshot(page)).queued.some((q) => q.includes("survives with full state"));

    let sawRow = false;
    for (let i = 0; i < 60 && !sawRow; i++) {
      if (await sawOurRow()) { sawRow = true; break; }
      if (await restarted()) break;
      await page.waitForTimeout(1_000);
    }
    if (!sawRow && (await restarted())) {
      test.skip(true, "the conversation's pod restarted mid-test: the run this asserts on was killed by the platform, so there is no in-flight queue left to observe");
    }
    expect(sawRow, "the queued row must be re-derived from the log after a reload").toBe(true);
    const post = await step(page, "after reload");
    // Assert that this test's message text survived rather than that the queue is
    // byte-identical: the platform may enqueue its own recovery prose, and the "Priority"
    // pill can legitimately change across a reload.
    expect(post.queued.join("|"), "the queued message survived the reload").toContain(
      "survives with full state",
    );
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
    // Retry the answer while the panel is still up, since a click made before the panel is
    // wired never reaches the agent.
    const green = page.locator('[data-testid="interrupt-option"]').filter({ hasText: /green/i });
    await expect(green).toBeEnabled({ timeout: 30_000 });
    await expect(async () => {
      if (await page.locator('[data-testid="interrupt-panel"]').isVisible().catch(() => false)) {
        await green.click({ timeout: 5_000 }).catch(() => {});
      }
      await expect(page.getByText(/you picked: green/i).first()).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 60_000 });

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
