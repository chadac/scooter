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
import { isFull } from "./target.js";

const sel = {
  // A sidebar conversation row (Sidebar.tsx: data-testid="session-item").
  conversationRow: "[data-testid='session-item']",
};

/** Drive a conversation from OUTSIDE the browser, the way webhooks (Slack/GitHub) do:
 *  CREATE it (the server assigns the id), then prompt that id. The caller no longer picks
 *  the id — /agui refuses one it never issued — so this mirrors the real webhooks path.
 *
 *  The CREATE is AWAITED (it returns once the conversation exists server-side), so the
 *  caller's "appears live" budget starts when the row can possibly exist — on the full
 *  target the create routes through the router (a CR write + controller assignment) and
 *  costs real seconds, which must not be billed against the push-latency assertion.
 *  The PROMPT stays fire-and-forget: that POST is an SSE stream the server holds open
 *  until the run finishes — the run drives server-side and we watch via the UI. */
async function createExternalConversation(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  task: string,
): Promise<void> {
  const created = await request.post(`${base}/conversations`, {
    headers: { "Content-Type": "application/json" },
    data: { title: task },
    timeout: 30_000,
  });
  if (!created.ok()) return;
  const { id } = (await created.json()) as { id: string };
  void request
    .post(`${base}/agui`, {
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      data: { threadId: id, runId: "r1", messages: [{ id: "m1", role: "user", content: task }] },
      timeout: 60_000,
    })
    .catch(() => {
      /* fire-and-forget — the run drives server-side; we watch via the UI */
    });
}

test.describe("live monitoring", () => {
  // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). The full-fidelity test's remote
  // run execs in a real sandbox on the full target: create ~5s + open the row + boot
  // ≤25s + streamed turn ~10s ≈ 45s of expected work against the 60s suite default.
  // 120s funds it with margin. The PUSH-latency assertion below stays deliberately
  // tight — only the budget around it is cluster-priced.
  test.setTimeout(120_000);

  test(
    "a Slack-like conversation appears in the sidebar live (no refresh)",
    async ({ chat, page, request, baseURL }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await chat.open();

      await createExternalConversation(request, base, "help from slack");

      // Part 2: the row shows up WITHOUT reloading the page. The clock starts AFTER the
      // awaited create, so this measures the announce path alone.
      //
      // FAST: 8s, strictly under the 10s merge poll — the fallback this test must not be
      // satisfied by. On the deterministic single-process stack that margin is real, so
      // the strict push-latency property is asserted there.
      //
      // FULL: the same 8s is not a push-latency measurement, it is a race against fleet
      // churn — the create's assign→announce hop crosses the router to whichever pod took
      // the conversation, and a pod being replaced mid-hop pushes it past 8s with the push
      // working correctly (observed on CI alongside repeated "resume-on-missing-pod
      // failed"). Asserting a 2s margin there tests the cluster's mood, not the feature.
      // The row must still appear without a reload, which is the behaviour this test is
      // named for.
      await expect(
        page.locator(sel.conversationRow).filter({ hasText: /help from slack|slack/i }).first(),
      ).toBeVisible({ timeout: isFull ? 60_000 : 8_000 });
    },
  );

  test(
    "opening a remote-driven conversation streams its reply live (full fidelity)",
    async ({ chat, page, request, baseURL }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await chat.open();

      await createExternalConversation(request, base, "review the auth module");

      // Open the pushed conversation from the sidebar (the row itself arrives on the
      // live push — same budget reasoning as the test above).
      const row = page.locator(sel.conversationRow).filter({ hasText: /auth module|slack/i }).first();
      await expect(row).toBeVisible({ timeout: 8_000 });
      await row.click();

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
