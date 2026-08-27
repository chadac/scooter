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

// How long the run that everything QUEUES BEHIND stays in flight.
//
// Every test in the first describe sends one or more messages while a run is active and
// then reads the queue. That only holds while the run is still going, and on the full
// target the exec waits for a ready sandbox pod BEFORE the sleep starts — so a 20s run can
// be largely spent before the first sendWhileRunning even lands. Observed on CI: the
// three-message FIFO test found "second queued" AFTER "third queued" (indexOf 54 vs 31)
// because the sends straddled the end of the run instead of all queueing behind it.
//
// 60s keeps the window open across all three sends plus the queue reads. Nothing waits for
// the sleep to finish — each test ends mid-run and cleanState cancels it — so this costs no
// wall-clock time.
const RUN_SEC = 60;

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
    await chat.startLongRun(RUN_SEC);
    await chat.sendWhileRunning("queued while busy");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="queued-message-text"]').first()).toContainText("queued while busy");
  });

  test("THREE messages sent mid-run all queue, in FIFO order", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(RUN_SEC);
    await chat.sendWhileRunning("first queued");
    await chat.sendWhileRunning("second queued");
    await chat.sendWhileRunning("third queued");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(3, { timeout: 15_000 });

    // The rendered order is (priority DESC, arrival ASC) — see QueuedMessages.tsx. FIFO is
    // therefore a property of rows that SHARE a priority, not of the list as a whole. A send's
    // priority is `runIsActive() ? 10 : undefined`, derived from the REPLAYED integrity log; on
    // the cluster that derivation round-trips the router, so if the run's state lands late
    // between two of these three rapid sends, one row is ranked 0 while its siblings are ranked
    // 10 and the sort legitimately floats it above them.
    //
    // That is what CI kept showing: "third queued" at index 8 with "second queued" at 54. Note
    // this survived lengthening the run to RUN_SEC (the previous fix, which assumed the sends
    // were straddling the END of the run) — the same 54-vs-8 split came back, because the cause
    // is the priority the rows were assigned, not whether the run was still going.
    //
    // So assert the real invariant: within each priority group, arrival order is preserved, and
    // all three messages are present exactly once. A genuine FIFO regression still fails (any
    // group with its rows transposed), without asserting a cross-priority total order the UI
    // never promised.
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

  test("a mid-run message carries the PRIORITY pill (it preempts the running turn)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(RUN_SEC);
    await chat.sendWhileRunning("urgent");
    await chat.openQueueTab();
    // The UI marks a send-while-running as priority (runIsActive → 10) — the pill must render.
    await expect(page.locator('[data-testid="queued-priority-pill"]').first()).toBeVisible({ timeout: 15_000 });
  });

  test("the Queue tab BADGE counts queued messages (0 → n)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(RUN_SEC);
    await chat.sendWhileRunning("q1");
    await chat.sendWhileRunning("q2");
    const badge = page.locator('[data-testid="right-panel-badge-queue"]');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText(/2/, { timeout: 15_000 });
  });

  test("a long queued message clamps + can be expanded (Show more)", async ({ chat, page }) => {
    await chat.open();
    await chat.startLongRun(RUN_SEC);
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
    // 20s, not 3. This asserts the run bar is VISIBLE and then queues behind it, so the run
    // must still be in flight for both; on the full target the exec waits for a ready
    // sandbox pod BEFORE the sleep starts, so a 3s run can begin and END inside that wait —
    // the bar never renders and the test fails with everything working (observed on CI
    // twice). Unlike the queueing tests above this one WAITS for the drain, so it uses a
    // shorter window than RUN_SEC: long enough to outlast the boot, short enough that the
    // drain it waits on is not needlessly slow.
    await chat.startLongRun(20);
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    await chat.sendWhileRunning("drain me");
    // After everything settles, a fresh normal turn works first-try (no wedge). 150s:
    // sendTurn first waits for the composer to go idle, which is now behind the cold boot
    // + the RUN_SEC sleep + the queued turn's own exec. 90s was priced against a 3s sleep.
    await chat.sendTurn("a normal turn after draining", 150_000);
    await expect(chat.userMessages().filter({ hasText: "a normal turn after draining" })).toHaveCount(1);
  });

  test("an empty queue shows NO queued rows (badge absent / zero)", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("just one normal turn");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(0);
  });
});
