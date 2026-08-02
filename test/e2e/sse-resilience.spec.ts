/**
 * Tier 3 E2E — SSE RESILIENCE. Proves the live UI recovers from stream failures
 * that a dropped/stalled/killed integrity frame would otherwise wedge on — the
 * "the agent seemed dead / couldn't receive messages" class of bug.
 *
 * Faults are injected by the SSE fault proxy (test/e2e/support/faultProxy.mjs)
 * that sits between the UI dev server and the agent-host. Each test sets a fault
 * via the proxy's control endpoint, drives a normal turn, and asserts the UI
 * recovers (the idle-watchdog reconnect re-folds the persisted log). The e2e UI
 * runs with a small VITE_IDLE_RECONNECT_MS (2s) so recovery fires within the test.
 *
 * The automatic "no error in the UI" fixture still applies — a recovery that
 * surfaced a stuck error box would fail the test.
 */

import { test, expect } from "./fixtures.js";

// The proxy's control endpoint (it listens on 8090; the UI proxies to it).
const PROXY = "http://localhost:8090";

async function setFault(request: import("@playwright/test").APIRequestContext, fault: Record<string, unknown>) {
  const res = await request.post(`${PROXY}/__fault`, { data: fault });
  expect(res.ok()).toBeTruthy();
}
async function clearFault(request: import("@playwright/test").APIRequestContext) {
  await setFault(request, { mode: "none" });
}

test.describe("SSE resilience", () => {
  // Always clear the fault after each test so a leak can't wedge the next one on
  // the shared serial backend.
  test.afterEach(async ({ request }) => {
    await clearFault(request);
  });

  test("dropped RUN_FINISHED — the UI un-sticks (Send returns) and can send again", async ({ chat, page, request }) => {
    await chat.open();
    // Establish a healthy conversation first (creates the durable log the recovery
    // re-folds from), with NO fault active.
    await chat.sendTurn("first, a normal turn");

    // Now DROP the terminal RUN_FINISHED on every future integrity frame: a
    // finished run will look "still running" on the live stream.
    await setFault(request, { mode: "drop", eventType: "RUN_FINISHED" });
    await chat.send("this run's finish will be dropped");

    // The reply text still streams (only the terminal frame is dropped), so the
    // assistant message lands...
    await expect(chat.assistantMessages().nth(1)).toBeVisible({ timeout: 30_000 });

    // ...but without RUN_FINISHED the composer stays in the running state (no Send)
    // until the idle-watchdog (2s) forces a reconnect that re-folds the persisted
    // log — which HAS the RUN_FINISHED — and clears `running`. Send returns.
    const sendBtn = page.getByRole("button", { name: /send/i }).first();
    await expect(sendBtn).toBeVisible({ timeout: 15_000 });

    // The real proof it's not "dead": a NEW message sends and gets a reply.
    await clearFault(request);
    await chat.send("am I still alive?");
    await expect(chat.userMessages()).toHaveCount(3, { timeout: 30_000 });
    await expect(chat.assistantMessages().nth(2)).toBeVisible({ timeout: 30_000 });
  });

  test("killAfter mid-stream — the reconnect re-folds; the reply completes with no duplicate", async ({ chat, page, request }) => {
    await chat.open();
    await chat.sendTurn("baseline turn");

    // Kill the integrity connection after a few frames: the UI must reconnect and
    // re-fold the persisted log rather than losing the turn or doubling it.
    await setFault(request, { mode: "killAfter", n: 3 });
    await chat.send("survive a mid-stream kill");

    // The turn still resolves after reconnect: a new user + assistant message, and
    // EXACTLY one new assistant message (no duplicate from a double-folded replay).
    await expect(chat.userMessages()).toHaveCount(2, { timeout: 30_000 });
    await expect(chat.assistantMessages()).toHaveCount(2, { timeout: 30_000 });
    // Composer is usable again.
    await expect(page.getByRole("button", { name: /send/i }).first()).toBeVisible({ timeout: 15_000 });
  });

  test("stalled stream — messages arrive late but correctly, no error box", async ({ chat, request }) => {
    await chat.open();
    await chat.sendTurn("pre-stall turn");

    // Hold the next stream for 1.5s, then resume: delivery is slow but complete.
    await setFault(request, { mode: "stall", stallMs: 1500 });
    await chat.send("delivered slowly");

    // The reply still lands (just later). The auto no-error fixture guards that the
    // stall didn't surface an error box.
    await expect(chat.userMessages()).toHaveCount(2, { timeout: 30_000 });
    await expect(chat.assistantMessages().nth(1)).toBeVisible({ timeout: 30_000 });
  });

  test("expired ingress auth (401 on the stream) surfaces a clear error, not a silent hang", async ({ chat, page, request }) => {
    await chat.open();
    await chat.sendTurn("before the session expires");

    // Simulate the ingress auth session expiring in front of the agent-host: the
    // integrity stream now 401s. The UI must SURFACE this (a visible error /
    // disconnected state), not sit forever pretending the agent is alive.
    await setFault(request, { mode: "authExpire" });

    // Force a fresh stream connection (reload) so it hits the 401.
    await page.reload();

    // The app must show the durable "session expired — reconnecting" banner rather
    // than a silent, permanently-"connecting" shell.
    await expect(page.getByTestId("stream-auth-error-bar")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("stream-auth-error-message")).toContainText(/session expired/i);

    // Recovery: once auth is renewed (fault cleared), the banner self-clears and
    // the conversation is usable again — no reload required.
    await clearFault(request);
    await expect(page.getByTestId("stream-auth-error-bar")).toBeHidden({ timeout: 15_000 });
  });
});
