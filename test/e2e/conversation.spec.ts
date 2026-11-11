/**
 * Tier 3 E2E for the core happy path through the real assistant-ui Thread, against the
 * local dummy-agent stack booted by the playwright.config webServer. The dummy agent
 * streams a deterministic turn: reasoning -> tool call -> a reply echoing the prompt.
 */

import { test, expect } from "./fixtures.js";

test.describe("conversation happy path", () => {
  // On the full target every turn runs a real exec in the sandbox, so each test's first
  // turn funds a cold boot.
  test.setTimeout(240_000);

  test("sending a message streams an assistant reply", async ({ chat }) => {
    await chat.open();
    await chat.send("Please review the auth module");

    // The dummy agent echoes the prompt back in its reply.
    await chat.waitForReply(/dummy agent/i);
    await expect(chat.userMessages().first()).toContainText(/review the auth module/i);
  });

  test("!cmd runs a real sandbox command and shows its output", async ({ chat, page }) => {
    await chat.open();
    // The "!" prefix runs the rest as a bash command in the sandbox via the real exec path
    // (local subprocess in fake mode, pod exec in cluster mode).
    await chat.send("!echo zxcvbnm-marker");

    // This is the conversation's first turn, so on the full target it sits behind a cold pod boot.
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 90_000 });
    // The folded tool card names the command the agent ran in its header, scoped to the card
    // so the echoed user message cannot satisfy it; opening it shows the full command.
    const trigger = page.locator('[data-testid="provider-tool-trigger"]').filter({ hasText: /echo zxcvbnm-marker/ });
    await expect(trigger).toBeVisible({ timeout: 90_000 });
    const body = page.locator('[data-testid="provider-tool-body"]').filter({ hasText: /echo zxcvbnm-marker/ });
    await expect(body).toBeHidden();
    await trigger.click();
    await expect(body).toBeVisible();
    // The command output (echo's result) flows back into the reply.
    await expect(chat.assistantMessages().last()).toContainText(/zxcvbnm-marker/i, { timeout: 90_000 });
  });

  test("!cmd evaluates shell (not a literal echo of the message)", async ({ chat }) => {
    await chat.open();
    await chat.send("!echo $((6 * 7))");
    // Proves the command runs in a shell (output is 42, not the literal text), behind a cold
    // pod boot on the full target.
    await expect(chat.assistantMessages().last()).toContainText(/\b42\b/, { timeout: 90_000 });
  });

  test("refresh (re-run) completes without an error", async ({ chat, page }) => {
    await chat.open();
    await chat.send("review this");
    await chat.waitForReply(/dummy agent/i);

    // Hover the assistant message to reveal the action bar, then click Refresh.
    await page.locator(".aui-md").first().hover();
    const refresh = page.getByRole("button", { name: /refresh/i }).first();
    await refresh.click();

    // A second reply renders; the auto no-error fixture asserts no AGUIError.
    await chat.waitForReply(/dummy agent/i);
  });

  test("multi-turn: a follow-up continues the same thread", async ({ chat }) => {
    await chat.open();
    // sendTurn guarantees the first run finished before the second send.
    await chat.sendTurn("first message");

    await chat.send("second message");
    await expect(chat.userMessages()).toHaveCount(2, { timeout: 30_000 });
    // Both replies present.
    await expect(chat.assistantMessages().nth(1)).toBeVisible({ timeout: 30_000 });
  });
});
