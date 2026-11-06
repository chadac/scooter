/**
 * Tier 3 E2E for extreme hostile stream conditions: persistent corruption (every
 * occurrence, not one-shot), corruption of the terminal events that drive run-state,
 * corruption while an interrupt is pending, corruption stacked with a reconnect, and a
 * long hostile session with corruption on every turn. Every step asserts the whole-UI
 * invariants and the DOM-vs-server agreement.
 */

import { test, expect, snapshot, assertConsistent, assertMatchesServer } from "./fixtures.js";
import { fastOnly } from "./target.js";
import type { APIRequestContext } from "@playwright/test";

const PROXY = "http://localhost:8090";
const setFault = async (r: APIRequestContext, f: Record<string, unknown>) => {
  expect((await r.post(`${PROXY}/__fault`, { data: f })).ok()).toBeTruthy();
};
const clearFault = (r: APIRequestContext) => setFault(r, { mode: "none" });

fastOnly("needs the SSE fault proxy to corrupt stream frames")("extreme stream corruption", () => {
  test.use({ baseURL: "http://localhost:5273" });
  test.afterEach(async ({ request }) => { await clearFault(request); });

  test("PERSISTENT duplication (every content frame, not one-shot) must not inflate the transcript", async ({ chat, page, request, baseURL }) => {
    await chat.open();
    await chat.completeTurn("baseline before persistent duplication");
    const before = await snapshot(page);

    // once:false delivers every TEXT_MESSAGE_CONTENT frame twice for the whole turn.
    await setFault(request, { mode: "duplicate", eventType: "TEXT_MESSAGE_CONTENT", n: 1, once: false });
    await chat.completeTurn("every content frame duplicated");
    await clearFault(request);

    const s = await snapshot(page);
    assertConsistent(s, "after persistent duplication");
    expect(s.userMessages, "exactly one new user turn").toBe(before.userMessages + 1);
    expect(s.assistantMessages, "exactly one new reply").toBe(before.assistantMessages + 1);
    await assertMatchesServer(page, request, baseURL, "after persistent duplication");
  });

  test("a DUPLICATED RUN_FINISHED must not double-drain the queue or wedge run-state", async ({ chat, page, request, baseURL }) => {
    // A queued turn draining behind a sleeping run needs more than the 60s suite default.
    test.setTimeout(180_000);
    await chat.open();
    await chat.completeTurn("baseline before terminal duplication");
    // Keep the in-flight window just long enough to queue behind, without padding the runtime.
    await chat.startLongRun(3);
    await chat.sendWhileRunning("queued behind a duplicated terminal");
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 20_000 });

    // The terminal event that ends a run, delivered 3x while a message waits in the queue.
    await setFault(request, { mode: "duplicate", eventType: "RUN_FINISHED", n: 2 });
    await expect.poll(async () => (await snapshot(page)).queued.length, { timeout: 90_000 }).toBe(0);
    await chat.waitForIdle(90_000);

    const s = await snapshot(page);
    assertConsistent(s, "after a duplicated terminal");
    expect(
      await page.locator(".aui-user-message-content").filter({ hasText: "queued behind a duplicated terminal" }).count(),
      "the queued message ran EXACTLY once despite a triple RUN_FINISHED",
    ).toBe(1);
    await assertMatchesServer(page, request, baseURL, "after a duplicated terminal");
  });

  test("a DUPLICATED RUN_STARTED must not leave the UI stuck 'running'", async ({ chat, page, request }) => {
    await chat.open();
    await chat.completeTurn("baseline before run-started duplication");
    await setFault(request, { mode: "duplicate", eventType: "RUN_STARTED", n: 2 });
    await chat.completeTurn("run started three times");

    const s = await snapshot(page);
    assertConsistent(s, "after a duplicated RUN_STARTED");
    // The decisive check: a duplicated start must not leave a phantom run in flight.
    expect(s.running, "the UI must not be stuck running after duplicated RUN_STARTED").toBe(false);
    expect(s.composerSendable, "the composer must be usable again").toBe(true);
  });

  test("corruption WHILE AN INTERRUPT IS PENDING must keep the approval answerable", async ({ chat, page, request, baseURL }) => {
    // A 60s wait inside the 60s suite default leaves no headroom.
    test.setTimeout(180_000);
    await chat.open();
    await chat.completeTurn("baseline before interrupt corruption");
    await chat.send("?pick a color");
    await expect(page.locator('[data-testid="interrupt-panel"]')).toBeVisible({ timeout: 30_000 });

    // Corrupt the stream while the run is paused awaiting a human answer.
    await setFault(request, { mode: "garbage", afterN: 1 });
    const paused = await snapshot(page);
    assertConsistent(paused, "interrupt pending under corruption");
    expect(paused.interruptOptions, "the approval must still be answerable under corruption").toBeGreaterThan(0);

    // And it must actually still work.
    await page.locator('[data-testid="interrupt-option"]').filter({ hasText: /green/i }).click();
    await expect(page.getByText(/you picked: green/i).first()).toBeVisible({ timeout: 30_000 });
    await chat.waitForIdle(60_000);
    const done = await snapshot(page);
    assertConsistent(done, "after answering under corruption");
    expect(done.interruptOpen, "the panel closes after answering").toBe(false);
    await assertMatchesServer(page, request, baseURL, "after answering under corruption");
  });

  test("a KILLED stream whose RECONNECT is then corrupted still converges on the server's truth", async ({ chat, page, request, baseURL }) => {
    // A run draining behind a queued turn needs more than the 60s suite default.
    test.setTimeout(180_000);
    await chat.open();
    await chat.completeTurn("baseline before stacked faults");
    const before = await snapshot(page);

    // Kill the stream mid-turn; the client reconnects, and the replay it fetches is corrupted too.
    await setFault(request, { mode: "killAfter", n: 2 });
    await chat.send("stacked faults: kill then corrupt");
    await page.waitForTimeout(500);
    await setFault(request, { mode: "garbage", afterN: 1 });
    await expect
      .poll(async () => (await snapshot(page)).assistantMessages, { timeout: 90_000 })
      .toBeGreaterThan(before.assistantMessages);
    await chat.waitForIdle(90_000);
    await clearFault(request);

    const s = await snapshot(page);
    assertConsistent(s, "after stacked faults");
    await assertMatchesServer(page, request, baseURL, "after stacked faults");
  });

  test("a LONG hostile session (10 turns, corruption on every turn) keeps EXACT counts", async ({ chat, page, request, baseURL }) => {
    await chat.open();
    await chat.completeTurn("baseline before the long hostile session");
    const faults: Array<Record<string, unknown>> = [
      { mode: "duplicate", eventType: "TEXT_MESSAGE_CONTENT", n: 2 },
      { mode: "garbage", afterN: 2 },
      { mode: "bogusEvent", afterN: 1 },
      { mode: "truncate", afterN: 2 },
      { mode: "reorder", eventType: "TEXT_MESSAGE_START" },
      { mode: "duplicate", eventType: "TOOL_CALL_START", n: 1 },
      { mode: "corruptChecksum", afterN: 2 },
      { mode: "duplicate", eventType: "RUN_FINISHED", n: 1 },
      { mode: "garbage", afterN: 3 },
      { mode: "bogusEvent", afterN: 2 },
    ];
    for (let i = 0; i < faults.length; i++) {
      await setFault(request, faults[i]);
      await chat.completeTurn(`hostile session turn ${i + 1}`, 60_000);
      const s = await snapshot(page);
      assertConsistent(s, `hostile session turn ${i + 1}`);
      // The transcript grows by exactly one turn per send (+1 for the baseline).
      expect(s.userMessages, `turn ${i + 1}: exact user count`).toBe(i + 2);
      expect(s.assistantMessages, `turn ${i + 1}: exact assistant count`).toBe(i + 2);
      expect(s.queued, `turn ${i + 1}: no phantom queue rows`).toEqual([]);
    }
    await clearFault(request);
    await assertMatchesServer(page, request, baseURL, "after a 10-turn hostile session");
  });
});
