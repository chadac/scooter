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

  test("!cmd runs a real sandbox command and shows its output", async ({ chat, page }) => {
    await chat.open();
    // The "!" prefix runs the rest as a bash command in the sandbox via the
    // REAL exec path (ACP createTerminal -> bridge -> ExecBackend; local
    // subprocess in fake mode, pod exec in cluster mode). This is the e2e
    // command harness — `!agent-broker test/whoami` rides the same path to
    // verify broker/IRSA auth in cluster mode.
    await chat.send("!echo zxcvbnm-marker");

    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 30_000 });
    // The tool card shows the COMMAND the agent ran (not just an empty result) —
    // the args ride a tool_call_update, which the bridge must surface as
    // TOOL_CALL_ARGS, and the shell card renders it as "$ <command>". Scoped to the
    // card body so it can't be satisfied by the echoed user message. Regression
    // guard for the "empty tool card" bug.
    await expect(
      page.locator('[data-testid="provider-tool-body"]').filter({ hasText: /echo zxcvbnm-marker/ }),
    ).toBeVisible({ timeout: 30_000 });
    // The command output (echo's result) flows back into the reply.
    await expect(chat.assistantMessages().last()).toContainText(/zxcvbnm-marker/i, { timeout: 30_000 });
  });

  test("!cmd evaluates shell (not a literal echo of the message)", async ({ chat }) => {
    await chat.open();
    await chat.send("!echo $((6 * 7))");
    // Proves the command runs in a shell — output is 42, not the literal text.
    await expect(chat.assistantMessages().last()).toContainText(/\b42\b/, { timeout: 30_000 });
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
    // sendTurn (count-based) guarantees the first run FINISHED before the second
    // send, which otherwise races an unfinished run and gets dropped.
    await chat.sendTurn("first message");

    await chat.send("second message");
    await expect(chat.userMessages()).toHaveCount(2, { timeout: 30_000 });
    // Both replies present.
    await expect(chat.assistantMessages().nth(1)).toBeVisible({ timeout: 30_000 });
  });
});
