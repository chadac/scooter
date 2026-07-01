/**
 * Tier 3 E2E — live conversation monitoring (the acceptance test for the whole
 * feature). Marked `fixme` until part 1 + part 2 are implemented.
 *
 * Simulates a Slack-originated conversation the way the webhooks service creates
 * one: a fire-and-forget POST /agui with a NEW threadId this browser tab did NOT
 * start. Then asserts, WITHOUT any manual refresh:
 *
 *   Part 2 — the new conversation appears in the sidebar live (pushed via
 *            GET /conversations/events, not the 10s poll).
 *   Part 1 — opening it shows the assistant's reply streaming live (rendered from
 *            the integrity stream), full fidelity (the dummy agent emits reasoning
 *            + a tool call + a reply).
 *
 * See docs/LIVE_MONITORING_DESIGN.md.
 */

import { test, expect } from "./fixtures.js";

const sel = {
  // A sidebar row for a conversation (adjust to the real selector during impl).
  conversationRow: "[data-testid='conversation-row']",
};

/** Create an out-of-band conversation exactly like the webhooks service does:
 *  fire-and-forget POST /agui with a fresh threadId (no browser involvement). */
async function createExternalConversation(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  threadId: string,
  task: string,
): Promise<void> {
  await request.post(`${base}/agui`, {
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    data: { threadId, runId: "r1", messages: [{ id: "m1", role: "user", content: task }] },
  });
}

test.describe("live monitoring", () => {
  test.fixme(
    "a Slack-like conversation appears in the sidebar live (no refresh)",
    async ({ chat, page, request, baseURL }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await chat.open();

      const threadId = `slack-e2e-${Date.now()}`;
      await createExternalConversation(request, base, threadId, "help from slack");

      // Part 2: the row shows up WITHOUT reloading the page or waiting 10s.
      await expect(
        page.locator(sel.conversationRow).filter({ hasText: /help from slack|slack/i }).first(),
      ).toBeVisible({ timeout: 5_000 });
    },
  );

  test.fixme(
    "opening a remote-driven conversation streams its reply live (full fidelity)",
    async ({ chat, page, request, baseURL }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await chat.open();

      const threadId = `slack-e2e-${Date.now()}`;
      await createExternalConversation(request, base, threadId, "review the auth module");

      // Open the pushed conversation from the sidebar.
      await page.locator(sel.conversationRow).filter({ hasText: /auth module|slack/i }).first().click();

      // Part 1: the assistant reply (from a run THIS tab didn't start) renders
      // live via the integrity stream — full fidelity: reasoning + tool call +
      // reply all appear.
      await expect(chat.assistantMessages().last()).toContainText(/dummy agent/i, { timeout: 45_000 });
      await expect(chat.toolCalls().first()).toBeVisible({ timeout: 45_000 });
    },
  );

  test.fixme(
    "my own send routes fire-and-forget through /agui and renders via the stream",
    async ({ chat }) => {
      // With the single-source model, MY send is also rendered from the integrity
      // stream (not the /agui SSE). Assert a normal send still shows the reply.
      await chat.open();
      await chat.send("hello");
      await chat.waitForReply(/dummy agent/i);
    },
  );
});
