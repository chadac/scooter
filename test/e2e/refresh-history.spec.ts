/**
 * Tier 3 E2E — conversation history (esp. TOOL CALLS) survives a page refresh.
 *
 * The open conversation renders SOLELY from the integrity SSE stream
 * (events.integrity), which replays the full persisted event log on (re)connect
 * before going live. A page reload drops all live state and rebuilds purely from
 * that replay — so this is the true test that tool-call events are (a) persisted
 * and (b) faithfully re-materialized into the thread on reload, not just shown
 * live. Regression guard for "tool calls vanish after refresh".
 *
 * Every test also gets the automatic "no error in the UI" assertion (fixtures).
 */

import type { Locator } from "@playwright/test";

import { test, expect } from "./fixtures.js";

/**
 * The assistant message carrying `pattern`, whichever one that is.
 *
 * NOT `assistantMessages().last()`: the platform appends turns of its own (a resume
 * prompt when the host pod is replaced mid-test), so the newest message is not
 * reliably the reply under test. Why: PR #688.
 */
function assistantSaying(chat: { assistantMessages(): Locator }, pattern: RegExp): Locator {
  return chat.assistantMessages().filter({ hasText: pattern }).first();
}

test.describe("history survives a page refresh", () => {
  test("a tool call is still rendered after reload", async ({ chat, page }) => {
    await chat.open();
    // "!" runs a real sandbox command via the ACP createTerminal path -> the
    // bridge emits TOOL_CALL_START/ARGS/END/RESULT, which are persisted.
    await chat.send("!echo zxcvbnm-marker");

    // Live: the tool call renders and its output flows into the reply.
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 30_000 });
    await expect(assistantSaying(chat, /zxcvbnm-marker/i)).toBeVisible({ timeout: 30_000 });

    // Reload: all live state is gone; the page reconnects to events.integrity
    // and rebuilds history purely from the replayed log.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // The tool call — and the user message + assistant reply — must reappear
    // from the replay, not just from the live stream.
    await expect(chat.userMessages().first()).toContainText(/echo zxcvbnm-marker/i, { timeout: 30_000 });
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 30_000 });
    await expect(assistantSaying(chat, /zxcvbnm-marker/i)).toBeVisible({ timeout: 30_000 });
  });

  test("a multi-turn conversation with tool calls is intact after reload", async ({ chat, page }) => {
    await chat.open();
    await chat.send("!echo first-marker");
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 30_000 });
    await expect(assistantSaying(chat, /first-marker/i)).toBeVisible({ timeout: 30_000 });

    await chat.send("!echo second-marker");
    await expect(chat.toolCalls()).toHaveCount(2, { timeout: 30_000 });
    await expect(assistantSaying(chat, /second-marker/i)).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // Both turns' tool calls replay from the log (not one, not zero).
    await expect(chat.toolCalls()).toHaveCount(2, { timeout: 30_000 });
    await expect(chat.userMessages()).toHaveCount(2, { timeout: 30_000 });
  });
});
