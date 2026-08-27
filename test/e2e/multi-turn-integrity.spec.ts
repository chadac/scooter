/**
 * Tier 3 E2E — LONG multi-turn conversations stay fully consistent.
 *
 * Targets the general "the UI is unreliable over a long conversation" complaint: every turn must
 * render, nothing gets dropped, tool calls persist, and the whole transcript survives a reload with
 * the right counts. Uses the race-free `sendTurn` (count-based) so a slow turn never drops.
 */

import { test, expect } from "./fixtures.js";

test.describe("long multi-turn conversation integrity", () => {
  // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). On the full target EVERY turn —
  // plain text included — is a real sandbox exec (the fake agent shells
  // `echo <text>`), and the first turn additionally waits for the sandbox pod to be
  // ready (5-25s cold; client-server-identity measured 9-12s under CI CPU pressure).
  // Worst test here: 12 turns → boot 25s + 12 x ~8s warm exec ≈ 120s; the
  // switch-away test adds a SECOND conversation boot (+25s). The 60s default is
  // arithmetic-bound, not behaviour-bound. 240s = worst case with headroom, matching
  // client-server-identity's two-boot budget. Per-turn waits stay at sendTurn's 45s.
  test.setTimeout(240_000);

  test("12 back-and-forth turns all render (no dropped user or assistant messages)", async ({ chat }) => {
    await chat.open();
    const N = 12;
    for (let i = 1; i <= N; i++) await chat.sendTurn(`turn number ${i}`);
    // Every user turn AND every assistant reply is present — exact counts, no drops or dupes.
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });
    await expect(chat.assistantMessages()).toHaveCount(N, { timeout: 45_000 });
    // The last turn's text is actually in the transcript (not a stale earlier render).
    await expect(chat.userMessages().filter({ hasText: `turn number ${N}` })).toHaveCount(1);
  });

  test("a long conversation with TOOL CALLS every turn keeps all messages + tool cards", async ({ chat }) => {
    await chat.open();
    const N = 8;
    for (let i = 1; i <= N; i++) await chat.sendTurn(`!echo turn-${i}`);
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });
    // Each `!echo` turn ran a real sandbox command → a tool card per turn.
    await expect.poll(async () => chat.toolCalls().count(), { timeout: 45_000 }).toBeGreaterThanOrEqual(N);
  });

  test("the full transcript SURVIVES a reload with the same counts (no loss, no duplication)", async ({ chat, page }) => {
    await chat.open();
    const N = 10;
    for (let i = 1; i <= N; i++) await chat.sendTurn(`persist turn ${i}`);
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });

    await page.reload();
    // After a full reload the persisted log re-folds to EXACTLY the same transcript.
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });
    await expect(chat.assistantMessages()).toHaveCount(N, { timeout: 45_000 });
    // The LAST turn (N=10) and the FIRST turn are both present. Use exact-text match: a substring
    // "persist turn 1" also matches "persist turn 10", so assert on the full, unambiguous strings.
    await expect(chat.userMessages().filter({ hasText: `persist turn ${N}` })).toHaveCount(1);
    await expect(chat.userMessages().getByText("persist turn 1", { exact: true })).toHaveCount(1);
  });

  test("mid-conversation reload then CONTINUE — new turns append correctly after the reload", async ({ chat, page }) => {
    await chat.open();
    for (let i = 1; i <= 5; i++) await chat.sendTurn(`before reload ${i}`);
    await expect(chat.userMessages()).toHaveCount(5, { timeout: 45_000 });
    await page.reload();
    await expect(chat.userMessages()).toHaveCount(5, { timeout: 45_000 });
    // Continue the conversation after the reload — the count keeps growing correctly.
    await chat.sendTurn("after reload 1");
    await chat.sendTurn("after reload 2");
    await expect(chat.userMessages()).toHaveCount(7, { timeout: 45_000 });
  });

  test("the run status CLEARS after each turn (never a stuck 'working' between turns)", async ({ chat, page }) => {
    await chat.open();
    for (let i = 1; i <= 4; i++) {
      await chat.sendTurn(`clean turn ${i}`);
      // Between turns the composer is idle: Send is available (NOT stuck showing Stop/working).
      await expect(page.locator(".aui-composer-send, [aria-label=\"Send message\"]").first()).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0);
    }
  });

  test("switching AWAY to a new conversation and BACK preserves the long one's transcript", async ({ chat, page }) => {
    await chat.open();
    const N = 8;
    for (let i = 1; i <= N; i++) await chat.sendTurn(`switchable ${i}`);
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });

    // New conversation, one turn, then back to the first. 100s, not sendTurn's 45s
    // default: this one turn funds a whole SECOND conversation boot on the full
    // target (new agent-host assignment + a fresh sandbox pod) before its exec runs.
    await page.locator('[data-testid="new-session"]').click();
    await chat.sendTurn("a different conversation", 100_000);
    await page.locator('[data-testid="session-item"]').last().click(); // back to the long one
    // The long conversation re-renders in full (no truncation / loss on switch-back).
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });
    await expect(chat.userMessages().filter({ hasText: `switchable ${N}` })).toHaveCount(1);
  });
});
