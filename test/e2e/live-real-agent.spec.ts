/**
 * Tier 3 E2E — the whole-UI invariants against a LIVE deployment driving a REAL agent.
 *
 * Why this exists: five rounds of synthetic hostility (stream corruption, duplicated/reordered/
 * truncated frames, two-tab concurrency) could not break the UI — because the FAKE agent is
 * deterministic and fast. It never stalls unpredictably, never dies mid-tool-call, and never streams
 * at real LLM cadence. That is precisely the condition the reported unreliability lives in.
 *
 * So this points the SAME detector (snapshot + assertConsistent + assertMatchesServer) at a real
 * deployment running a real model (odin: claude-code / opus, real sandbox, real pods/exec). The
 * assertions are deliberately TIMING-AGNOSTIC — they never assume how long a turn takes, only that
 * the UI's surfaces agree with each other and with the server whenever it settles.
 *
 * Gated + non-destructive:
 *   RUN_LIVE_E2E=1 BASE_URL=https://scooter.odin.lan npx playwright test test/e2e/live-real-agent.spec.ts
 * It creates its OWN conversations and never deletes anyone else's. Because a real model is slow and
 * variable, timeouts are generous and counts are asserted as DELTAS from a baseline snapshot.
 */

import { test, expect, snapshot, assertConsistent, checkpoint, shot, type UiSnapshot } from "./fixtures.js";
import type { Page } from "@playwright/test";

const enabled = process.env.RUN_LIVE_E2E === "1";
const maybe = enabled ? test.describe : test.describe.skip;

// A real model turn can take a while (tool calls, cold sandbox, model latency).
const TURN = 240_000;
test.setTimeout(600_000);

/** Snapshot + assert the cross-component invariants; return it for step assertions. */
async function step(page: Page, when: string): Promise<UiSnapshot> {
  // checkpoint = snapshot + SCREENSHOT + invariants. Against a real model the timing is
  // nondeterministic, so a visual record of each step is what makes a failure interpretable.
  return checkpoint(page, when);
}

/** Open a BRAND-NEW conversation so we never touch existing ones. */
async function newConversation(page: Page) {
  await page.goto("/");
  await expect(page.locator('[aria-label="Message input"]').first()).toBeVisible({ timeout: 60_000 });
  const btn = page.locator('[data-testid="new-session"]');
  if (await btn.count()) await btn.first().click();
  await expect(page.locator('[aria-label="Message input"]').first()).toBeVisible({ timeout: 60_000 });
}

/** Send and wait for the reply, tolerating real-model latency. Returns the settled snapshot. */
async function liveTurn(page: Page, chat: { sendWhileRunning: (t: string) => Promise<void> }, text: string): Promise<UiSnapshot> {
  const before = await snapshot(page);
  await chat.sendWhileRunning(text);
  await expect
    .poll(async () => (await snapshot(page)).assistantMessages, { timeout: TURN })
    .toBeGreaterThan(before.assistantMessages);
  await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: TURN });
  await shot(page, `settled-${text.slice(0, 30)}`);
  return snapshot(page);
}

maybe("live deployment, real agent", () => {
  test("a real turn keeps every UI surface mutually consistent", async ({ chat, page }) => {
    await newConversation(page);
    const idle = await step(page, "fresh live conversation");
    expect(idle.runError, "a fresh conversation shows no error").toBeNull();

    await chat.sendWhileRunning("Reply with exactly: LIVE-OK");
    // While the REAL model works, the UI must stay internally coherent — this is the window the
    // fake agent skips through in milliseconds and where real unreliability would show.
    for (let i = 0; i < 12; i++) {
      await step(page, `during a real run (probe ${i + 1})`);
      await page.waitForTimeout(2_000);
      if ((await snapshot(page)).assistantMessages > idle.assistantMessages) break;
    }
    await expect
      .poll(async () => (await snapshot(page)).assistantMessages, { timeout: TURN })
      .toBeGreaterThan(idle.assistantMessages);
    await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: TURN });

    const done = await step(page, "after a real turn");
    expect(done.userMessages, "exactly one new user turn").toBe(idle.userMessages + 1);
    expect(done.composerSendable, "the composer returns to Send").toBe(true);
    expect(done.queued, "no phantom queue rows").toEqual([]);
  });

  test("a real TOOL CALL leaves the UI consistent (real sandbox, real pods/exec)", async ({ chat, page }) => {
    await newConversation(page);
    const before = await snapshot(page);
    // A real shell command through the real in-cluster exec path.
    const s = await liveTurn(page, chat, "Run the shell command `echo LIVE-TOOL-OK` and tell me its output.");
    assertConsistent(s, "after a real tool call");
    expect(s.toolCards, "a real tool call rendered a card").toBeGreaterThan(before.toolCards);
    expect(s.runError, "a successful tool call leaves no error").toBeNull();
    expect(s.running, "the run ended").toBe(false);
  });

  test("QUEUEING against a real (slow) run: the message queues, then drains exactly once", async ({ chat, page }) => {
    await newConversation(page);
    const before = await snapshot(page);

    // Give the real model a genuinely slow task so there's a real in-flight window to queue behind.
    await chat.sendWhileRunning("Count slowly from 1 to 20, one number per line, then say DONE-SLOW.");
    // Best-effort: wait for the run to look in-flight, but don't fail if a fast turn beat us there.
    await expect(page.locator('[data-testid="run-status-bar"]'))
      .toBeVisible({ timeout: 60_000 })
      .catch(() => {});
    await shot(page, "long-real-run-in-flight");
    await chat.sendWhileRunning("QUEUED-LIVE: reply with exactly QUEUED-OK");
    await chat.openQueueTab();
    // It must appear in the queue while the real run is still going.
    await expect
      .poll(async () => (await snapshot(page)).queued.join("|"), { timeout: 60_000 })
      .toContain("QUEUED-LIVE");
    assertConsistent(await snapshot(page), "queued behind a real run");

    // Both turns complete; the queued message ran EXACTLY once.
    await expect.poll(async () => (await snapshot(page)).queued.length, { timeout: TURN }).toBe(0);
    await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: TURN });
    const done = await step(page, "after the live queue drained");
    expect(done.userMessages, "both turns are in the transcript").toBe(before.userMessages + 2);
    expect(
      await page.locator(".aui-user-message-content").filter({ hasText: "QUEUED-LIVE" }).count(),
      "the queued message ran exactly once",
    ).toBe(1);
  });

  test("a RELOAD mid-real-run re-folds correctly (no lost turn, no stuck 'working')", async ({ chat, page }) => {
    await newConversation(page);
    const before = await snapshot(page);
    await chat.sendWhileRunning("Count slowly from 1 to 15, then say RELOAD-OK.");
    // Do NOT require the run bar to be visible: against a real model the turn may already have
    // finished by the time we look (or may not have started yet). Reload regardless — the property
    // under test is "a reload at an arbitrary moment re-folds correctly", which is timing-agnostic.
    await page.waitForTimeout(1_500);
    await shot(page, "just-before-reload-mid-real-run");
    await page.reload();
    await expect(page.locator('[aria-label="Message input"]').first()).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => (await snapshot(page)).assistantMessages, { timeout: TURN })
      .toBeGreaterThan(before.assistantMessages);
    await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: TURN });

    const s = await step(page, "after a reload mid-real-run");
    expect(s.composerSendable, "not stuck working after the reload").toBe(true);
    expect(s.userMessages, "the turn was not lost or duplicated").toBe(before.userMessages + 1);
  });

  test("a MULTI-TURN real conversation keeps exact counts and stays consistent throughout", async ({ chat, page }) => {
    await newConversation(page);
    const before = await snapshot(page);
    for (let i = 1; i <= 4; i++) {
      const s = await liveTurn(page, chat, `Turn ${i}: reply with exactly TURN-${i}-OK`);
      assertConsistent(s, `after live turn ${i}`);
      expect(s.userMessages, `live turn ${i}: exact user count`).toBe(before.userMessages + i);
      expect(s.assistantMessages, `live turn ${i}: exact assistant count`).toBe(before.assistantMessages + i);
      expect(s.queued, `live turn ${i}: no phantom queue`).toEqual([]);
      expect(s.runError, `live turn ${i}: no error`).toBeNull();
    }
  });
});
