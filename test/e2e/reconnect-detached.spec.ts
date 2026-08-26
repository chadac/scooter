/**
 * Tier 3 E2E — RECONNECT / REFRESH-mid-run + the "weird detached state" bugs.
 *
 * Targets the reported "requires a refresh to properly receive new messages" + "sometimes ends up in
 * a weird detached state" reliability problems. Two mechanisms:
 *   1. Page RELOADS at awkward moments (mid-run, mid-queue) — the UI must re-fold the persisted
 *      integrity log correctly (no lost messages, no stuck "working", no duplicates).
 *   2. The SSE fault proxy drops/kills/stalls live frames — the idle-watchdog reconnect must un-stick
 *      a UI that the server has already moved past (the detached state: server done, UI still busy).
 *
 * Fault-proxy tests use the isolated resilience stack (baseURL 5273, fast idle-watchdog). Pure-reload
 * tests use the pristine stack.
 */

import { test, expect } from "./fixtures.js";
import { fastOnly } from "./target.js";

const PROXY = "http://localhost:8090";
async function setFault(request: import("@playwright/test").APIRequestContext, fault: Record<string, unknown>) {
  const res = await request.post(`${PROXY}/__fault`, { data: fault });
  expect(res.ok()).toBeTruthy();
}
async function clearFault(request: import("@playwright/test").APIRequestContext) {
  await setFault(request, { mode: "none" });
}

fastOnly("needs the SSE fault proxy to kill the stream mid-run")("reload mid-run / mid-queue (pristine stack)", () => {
  test("reload WHILE a run is in flight → the run completes + its reply is visible (no lost turn)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("!sleep 3");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    const before = await chat.assistantMessages().count();
    await page.reload(); // reload mid-run — the persisted log must re-fold + the run finishes
    await expect.poll(async () => chat.assistantMessages().count(), { timeout: 45_000 }).toBeGreaterThan(before);
    // And the UI is not stuck "working" afterwards.
    await expect(page.locator(".aui-composer-send, [aria-label=\"Send message\"]").first()).toBeVisible({ timeout: 15_000 });
  });

  test("reload WHILE a message is queued → the queue persists and still drains", async ({ chat, page }) => {
    await chat.open();
    await chat.send("!sleep 4");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    await chat.sendWhileRunning("queued across a reload");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });

    await page.reload();
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 20_000 }); // survived the reload
    // Eventually the sleep + the queued run both finish → the queue empties + a reply lands.
    await expect(chat.queuedMessages()).toHaveCount(0, { timeout: 45_000 });
    await expect(chat.userMessages().filter({ hasText: "queued across a reload" })).toHaveCount(1);
  });

  test("TWO rapid reloads in a row don't wedge or duplicate the thread", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("a turn before the reload storm");
    const users = await chat.userMessages().count();
    await page.reload();
    await page.reload(); // immediately again — no double-fold / duplication
    await expect(chat.userMessages()).toHaveCount(users, { timeout: 30_000 });
    // Still fully functional after: a new turn works first-try.
    await chat.sendTurn("still works after two reloads");
    await expect(chat.userMessages()).toHaveCount(users + 1, { timeout: 45_000 });
  });

  test("live delivery WITHOUT a refresh — a reply appears on its own (no manual reload needed)", async ({ chat }) => {
    await chat.open();
    const before = await chat.assistantMessages().count();
    await chat.send("deliver me live");
    // The reply must arrive over the live stream — assert WITHOUT reloading the page.
    await expect.poll(async () => chat.assistantMessages().count(), { timeout: 45_000 }).toBeGreaterThan(before);
  });
});

test.describe("detached state recovery (fault-proxy stack)", () => {
  test.use({ baseURL: "http://localhost:5273" });
  test.afterEach(async ({ request }) => { await clearFault(request); });

  test("server finished but the UI missed RUN_FINISHED → sending queues, then the watchdog un-sticks it", async ({ chat, page, request }) => {
    await chat.open();
    await chat.sendTurn("healthy first turn");
    // Drop the NEXT RUN_FINISHED → the UI thinks the run is still going (detached from the server,
    // which has finished). The idle-watchdog reconnect re-folds the intact persisted log to recover.
    await setFault(request, { mode: "drop", eventType: "RUN_FINISHED" });
    await chat.send("this finish gets dropped");
    // Recovery: the reply finalizes + the composer un-sticks (no permanent "working" state).
    await expect(chat.assistantMessages()).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator(".aui-composer-send, [aria-label=\"Send message\"]").first()).toBeVisible({ timeout: 15_000 });
  });

  test("connection KILLED mid-stream → the reconnect re-folds; the reply completes with no duplicate", async ({ chat, request }) => {
    await chat.open();
    await chat.sendTurn("before the kill");
    const before = await chat.assistantMessages().count();
    await setFault(request, { mode: "killAfter", n: 2 }); // close the stream after 2 frames
    await chat.send("stream dies mid-reply");
    // The reconnect re-folds the log → exactly one new assistant message (no dupes from re-fold).
    await expect.poll(async () => chat.assistantMessages().count(), { timeout: 30_000 }).toBe(before + 1);
  });

  test("a STALLED stream delivers late but correctly, and never leaves an error box", async ({ chat, request }) => {
    await chat.open();
    const before = await chat.assistantMessages().count();
    await setFault(request, { mode: "stall", stallMs: 1500 });
    await chat.send("held back briefly");
    await expect.poll(async () => chat.assistantMessages().count(), { timeout: 30_000 }).toBeGreaterThan(before);
    // (The auto no-error-box fixture assertion covers "no stuck error".)
  });
});
