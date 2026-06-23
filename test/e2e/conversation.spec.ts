/**
 * Tier 3 E2E — the core happy path through the real assistant-ui Thread.
 *
 * Runs against the local dummy-agent stack (fake ACP agent, no cluster/model;
 * booted by playwright.config webServer). The dummy agent streams a
 * deterministic turn: reasoning -> tool call -> a reply echoing the prompt.
 *
 * Every test here also gets the automatic "no error in the UI" assertion from
 * fixtures.ts.
 */

import { test, expect } from "./fixtures.js";

test.describe("conversation happy path", () => {
  test("sending a message streams an assistant reply", async ({ chat }) => {
    await chat.open();
    await chat.send("Please review the auth module");

    // The dummy agent echoes the prompt back in its reply.
    await chat.waitForReply(/dummy agent/i);
    await expect(chat.userMessages().first()).toContainText(/review the auth module/i);
  });

  test("a tool call runs a real command and shows its output", async ({ chat }) => {
    await chat.open();
    await chat.send("zxcvbnm-marker");

    // The dummy agent makes a REAL createTerminal call (ACP -> bridge ->
    // ExecBackend -> local `echo` in fake mode), so its output flows back.
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 30_000 });
    // The reply echoes the command output — proving the exec chain ran.
    await expect(chat.assistantMessages().last()).toContainText(/zxcvbnm-marker/i, { timeout: 30_000 });
  });

  test("refresh (re-run) completes without an error", async ({ chat, page }) => {
    await chat.open();
    await chat.send("review this");
    await chat.waitForReply(/dummy agent/i);

    // Hover the assistant message to reveal the action bar, then click Refresh.
    await page.locator(".aui-md").first().hover();
    const refresh = page.getByRole("button", { name: /refresh/i }).first();
    await refresh.click();

    // A second reply renders; the auto no-error fixture asserts no AGUIError
    // ("Cannot send 'RUN_FINISHED' while text messages are still active").
    await chat.waitForReply(/dummy agent/i);
  });

  test("multi-turn: a follow-up continues the same thread", async ({ chat }) => {
    await chat.open();
    await chat.send("first message");
    await chat.waitForReply(/dummy agent/i);

    await chat.send("second message");
    await expect(chat.userMessages()).toHaveCount(2, { timeout: 30_000 });
    // Both replies present.
    await expect(chat.assistantMessages().nth(1)).toBeVisible({ timeout: 30_000 });
  });
});
