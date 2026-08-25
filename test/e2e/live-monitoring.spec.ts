/**
 * Tier 3 E2E — live conversation monitoring (the acceptance test for the whole
 * feature). Marked `fixme` until part 1 + part 2 are implemented.
 *
 * Simulates a Slack-originated conversation the way the webhooks service creates
 * one: an out-of-band CREATE + prompt for a conversation this browser tab did NOT
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
  // A sidebar conversation row (Sidebar.tsx: data-testid="session-item").
  conversationRow: "[data-testid='session-item']",
};

/** Create an out-of-band conversation exactly like the webhooks service does:
 *  an out-of-band create-then-prompt (no browser involvement).
 *  The POST is an SSE stream the server holds open until the run finishes, so we
 *  do NOT await the response body — just fire it and let the run drive server-side
 *  (its events reach an open UI via the integrity stream). */
/** Drive a conversation from OUTSIDE the browser, the way webhooks (Slack/GitHub) do:
 *  CREATE it (the server assigns the id), then prompt that id. The caller no longer picks
 *  the id — /agui refuses one it never issued — so this mirrors the real webhooks path. */
function createExternalConversation(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  task: string,
): void {
  void (async () => {
    const created = await request.post(`${base}/conversations`, {
      headers: { "Content-Type": "application/json" },
      data: { title: task },
      timeout: 30_000,
    });
    if (!created.ok()) return;
    const { id } = (await created.json()) as { id: string };
    await request.post(`${base}/agui`, {
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      data: { threadId: id, runId: "r1", messages: [{ id: "m1", role: "user", content: task }] },
      timeout: 60_000,
    });
  })().catch(() => {
    /* fire-and-forget — the run drives server-side; we watch via the UI */
  });
}

test.describe("live monitoring", () => {
  test(
    "a Slack-like conversation appears in the sidebar live (no refresh)",
    async ({ chat, page, request, baseURL }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await chat.open();

      createExternalConversation(request, base, "help from slack");

      // Part 2: the row shows up WITHOUT reloading the page or waiting 10s.
      await expect(
        page.locator(sel.conversationRow).filter({ hasText: /help from slack|slack/i }).first(),
      ).toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "opening a remote-driven conversation streams its reply live (full fidelity)",
    async ({ chat, page, request, baseURL }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await chat.open();

      createExternalConversation(request, base, "review the auth module");

      // Open the pushed conversation from the sidebar.
      await page.locator(sel.conversationRow).filter({ hasText: /auth module|slack/i }).first().click();

      // Part 1: the assistant reply (from a run THIS tab didn't start) renders
      // live via the integrity stream — full fidelity: reasoning + tool call +
      // reply all appear.
      await expect(chat.assistantMessages().last()).toContainText(/dummy agent/i, { timeout: 45_000 });
      await expect(chat.toolCalls().first()).toBeVisible({ timeout: 45_000 });
    },
  );

  test(
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
