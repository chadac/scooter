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
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). On the full target the exec waits
    // for a ready sandbox pod first (5-25s measured), so the run lasts up to ~30s; add
    // open + the multi-surface snapshots and the worst case brushes the 60s default on
    // arithmetic alone.
    test.setTimeout(120_000);
    await chat.open();
    const idle = await step(page, "after open");
    expect(idle.running, "a fresh conversation must not claim to be running").toBe(false);
    expect(idle.queued, "a fresh conversation must have an empty queue").toEqual([]);
    expect(idle.interruptOpen, "a fresh conversation must have no interrupt").toBe(false);
    expect(idle.runError, "a fresh conversation must have no error").toBeNull();

    // RUNNING: the run bar is up, the composer offers Stop (not Send), nothing else changed state.
    // 20s, not 3: this asserts the run bar is VISIBLE, so the run must still be in flight when
    // the assertion polls. On the full target the exec waits for a ready sandbox pod BEFORE the
    // sleep starts, so a 3s sleep can begin and END inside that wait — the bar never renders and
    // the test fails with everything behaving correctly (observed: "element(s) not found" after
    // the full 30s). The same arithmetic is why stop-run.spec.ts:75 uses a 20s sleep. Nothing
    // waits for this sleep to finish — the poll below ends the test as soon as the run does.
    await chat.send("!sleep 20");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    const running = await step(page, "while running");
    expect(running.running).toBe(true);
    expect(running.composerStop, "the composer must offer Stop while running").toBe(true);
    expect(running.runError, "a healthy run must not show an error").toBeNull();
    expect(running.userMessages, "the user's message renders immediately").toBeGreaterThan(idle.userMessages);

    // REPLIED: back to a fully idle, consistent state — no residue anywhere.
    // 60s, not 45: the poll starts once the bar is visible, but the 20s sleep above may only
    // just have begun (the ready-pod wait precedes it), so the run can still owe ~20s of sleep
    // plus the reply round-trip. 60s keeps a real margin inside the 120s test budget.
    await expect.poll(async () => (await snapshot(page)).running, { timeout: 60_000 }).toBe(false);
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
      // Wait for the last user message's text to be fully rendered before snapshotting.
      // The nightly run 33846941314 caught a race at turn 6 where the message element existed
      // but innerText was empty — the DOM update hadn't completed yet. Poll until the expected
      // text is present to avoid racing the render.
      await expect
        .poll(
          async () => {
            const userMessages = page.locator('.aui-user-message-content');
            const count = await userMessages.count();
            if (count < i) return false;
            const lastText = await userMessages.nth(count - 1).innerText().catch(() => "");
            return lastText.includes(`consistency turn ${i}`);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
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
    // Both messages are queued — that is the invariant. Their relative ORDER is not one this
    // test can assert, for the reason queue-durability.spec.ts documents at length: rows
    // render by (priority DESC, arrival ASC), and a send's priority is
    // `runIsActive() ? 10 : undefined` derived from the REPLAYED integrity log. On the
    // cluster that derivation round-trips the router, so if the run's state lands late
    // between these two rapid sends, beta is ranked differently from alpha and the sort
    // legitimately floats it. Observed on CI: this exact assertion failed as "FIFO order"
    // while both rows were present and correct.
    //
    // queue-durability.spec.ts owns the FIFO property and asserts it the honest way (within
    // a priority group). Here the point is cross-surface consistency, so assert presence.
    expect(two.queued.join("|"), "alpha is still queued").toContain("alpha");
    expect(two.queued.join("|"), "beta is queued").toContain("beta");
    expect(two.running, "still running with two queued").toBe(true);
  });

  test("the queue DRAINS into the thread with counts conserved (nothing lost, nothing duplicated)", async ({ chat, page, request, baseURL }) => {
    // A 60s wait inside the 60s suite default leaves ZERO headroom — the test dies at the same
    // moment its own poll would have. Give this one a budget larger than the work it waits on.
    test.setTimeout(180_000);
    await chat.open();
    // 20s, not 3: the whole point is that the second message QUEUES behind an in-flight run.
    // On the full target the exec waits for a ready sandbox pod before the sleep starts, so a
    // 3s sleep can be over by the time sendWhileRunning fires — the message then lands on an
    // IDLE conversation as an ordinary turn, the queue never holds it, and the conservation
    // count comes up one short (observed: expected 2, received 1) while nothing is actually
    // lost. A 20s sleep keeps the run in flight across the queueing window.
    await chat.send("!sleep 20");
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
    // 60s, not 20: the test asserts the queue still holds a row and `running === true` AFTER
    // the reload, so the run must outlive open→send→queue→snapshot→reload→re-derive. On the
    // full target that window is far wider than it looks — a 20s sleep was still being drained
    // before the post-reload poll could observe it (observed: queued.length stuck at 0 through
    // the whole 30s budget, expected 1, with the queue demonstrably working). The sandbox wait
    // precedes the sleep, so the sleep's own 20s is not the margin it appears to be. Nothing
    // waits for this sleep to finish (the test ends mid-run; cleanState cancels it), so the
    // longer sleep costs no wall-clock time.
    await chat.send("!sleep 60");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    await chat.sendWhileRunning("survives with full state");
    await chat.openQueueTab();
    const pre = await step(page, "before reload");

    await page.reload();
    await chat.openQueueTab();
    // 60s, not 30: the reload re-derives the whole conversation from the integrity log,
    // and on a cluster that round-trips the router to the owning pod. The queue row can
    // take longer to reappear than the fast stack's near-instant re-render.
    //
    // A pod RESTART during this window ends the test's premise rather than breaking the UI.
    // This test needs the `!sleep 60` run to still be in flight after the reload, so that a
    // queued row and `running === true` are there to observe. If the platform restarts the
    // conversation's pod, that run is killed, the platform's own resume/restart messages run
    // in its place, and the queue legitimately DRAINS — there is then no queued row and no
    // in-flight run, and every assertion below would report platform recovery as lost UI
    // state. Observed on CI: the post-reload page showed "No queued messages" with the
    // thread holding the platform's restart prose as a completed turn.
    //
    // Detect that specific situation and skip, rather than asserting through it. The skip is
    // narrow — it needs the restart marker actually present in the thread — so a genuine
    // "the queue vanished on reload" regression, which has no such marker, still fails below.
    // The marker can land ANYWHERE the restart's recovery message is rendered — the thread,
    // or the QUEUE itself. CI showed the second case: the queue held exactly one row and it
    // was the platform's restart prose, with the user's message gone. Checking only the
    // thread meant the loop below "saw a row", proceeded, and reported the platform's
    // recovery text as the user's lost message.
    const RESTART = /this conversation was interrupted by a restart/i;
    const restarted = async () => {
      if ((await page.getByText(RESTART).count()) > 0) return true;
      return (await snapshot(page)).queued.some((q) => RESTART.test(q));
    };
    // A row that is OURS — not the platform's recovery message wearing a queue row's clothes.
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
    // The WHOLE state re-derived, not just the row: thread counts, queue contents, run state.
    //
    // Assert THIS TEST'S message survived, rather than that the queue is byte-identical. On
    // the full target the platform legitimately enqueues its own recovery prose when a pod
    // restarts mid-run —, where the post-reload queue held
    //   "[System: this conversation was interrupted by a restart while you were working...]"
    // and an exact toEqual reported that platform behaviour as lost user state. What this
    // test is for is that the user's queued row survives a reload, and that is asserted
    // exactly as strictly as before; a dropped or corrupted row still fails.
    //
    // Compare on the MESSAGE TEXT this test sent, not on the whole row string. A row's
    // innerText is decorated with the "Priority" pill, and the pill is driven by the
    // priority the row is re-derived with — which a reload can legitimately change (it comes
    // from `runIsActive()` over the replayed log). Comparing decorated strings made this
    // fail as `queued text survived: Prioritysurvives with full state` when the message
    // itself was present and intact; the pill had simply gone.
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
    // RETRY the answer while the panel is still up. The panel becomes visible as soon as the
    // interrupt renders, but a click made before it is wired resolves to the element and
    // never reaches the agent — CI failed here with "you picked: green" absent for the full
    // 30s. Same fix, same reason, as interrupt.spec.ts's Dismiss. If answering is genuinely
    // broken the panel never clears and this still fails.
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
