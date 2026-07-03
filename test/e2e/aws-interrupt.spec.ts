/**
 * Tier 3 E2E — the AWS approval interrupt appears in the UI.
 *
 * When the agent requests AWS access, the broker POSTs the agent-host
 * /conversations/:id/aws-request, which calls bridge.raiseInterrupt — a bare
 * RUN_FINISHED(runId "ext-<id>", outcome interrupt) that is NOT tied to a goose
 * run and can arrive WHILE a run is in flight. It must surface as the
 * InterruptPanel (Approve / Deny). This is the "the approval window doesn't appear
 * at all" regression — a path with NO prior e2e coverage (the ?pick interrupt
 * tests the goose-permission path, which is a DIFFERENT mechanism).
 *
 * We drive the REAL broker→host route directly (the broker's _notify_host shape),
 * so this exercises route → raiseInterrupt → persist → integrity stream → UI.
 */

import { test, expect } from "./fixtures.js";

const panel = {
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  message: '[data-testid="interrupt-message"]',
};

/** POST the aws-request exactly like the broker's _notify_host does. */
async function requestAws(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  conversationId: string,
  requestId: string,
) {
  return request.post(`${base}/conversations/${encodeURIComponent(conversationId)}/aws-request`, {
    headers: { "Content-Type": "application/json" },
    data: {
      request_id: requestId,
      target_account: "dev",
      risk_level: "low",
      policy_summary: "s3:GetObject on the state bucket",
      justification: "read terraform state",
    },
  });
}

test.describe("AWS approval interrupt", () => {
  test("the approval panel appears when the broker requests AWS access", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();

    // A live conversation with an active bridge (a normal send builds it).
    await chat.send("start working on the terraform plan");
    await chat.waitForReply(/dummy agent/i);

    // The conversation id (== threadId). Grab it from the conversations list.
    const list = await (await request.get(`${base}/conversations`)).json();
    const conversationId: string = list[0].id;
    expect(conversationId).toBeTruthy();

    // The broker notifies the agent-host that the agent requested AWS access.
    const res = await requestAws(request, base, conversationId, `awsreq-${Date.now()}`);
    expect(res.status(), "the aws-request route must accept it (not 404 — no active bridge)").toBe(202);

    // The approval panel MUST appear, with Approve + Deny, describing the request.
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toHaveCount(1);
    await expect(page.locator(panel.option).filter({ hasText: /deny/i })).toHaveCount(1);
    await expect(page.locator(panel.message)).toContainText(/AWS access to dev/i);
  });

  test("the panel appears even when the conversation's bridge is inactive (suspended)", async ({ chat, page, baseURL, request }) => {
    // THE reported bug: the agent hit AWS after the conversation went idle (no live
    // bridge). The route used to 404 and the broker swallowed it → nothing appeared.
    // The route must now REVIVE the conversation and raise the interrupt anyway.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("long-running terraform work");
    await chat.waitForReply(/dummy agent/i);

    const list = await (await request.get(`${base}/conversations`)).json();
    const conversationId: string = list[0].id;

    // Suspend it (drops the in-memory bridge) — the idle-suspend / restart case.
    const susp = await request.post(`${base}/conversations/${encodeURIComponent(conversationId)}/suspend`);
    expect(susp.ok()).toBeTruthy();

    // Now the broker requests AWS. The route must revive + raise (not 404).
    const res = await requestAws(request, base, conversationId, `awsreq-susp-${Date.now()}`);
    expect(res.status(), "aws-request must revive an inactive conversation, not 404").toBe(202);

    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toHaveCount(1);
  });

  test("the AWS approval panel is still present after a page reload", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("another terraform task");
    await chat.waitForReply(/dummy agent/i);

    const list = await (await request.get(`${base}/conversations`)).json();
    const conversationId: string = list[0].id;
    await requestAws(request, base, conversationId, `awsreq-reload-${Date.now()}`);
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

    // The interrupt is PERSISTED, so it must survive a reload (rebuilt from the
    // integrity replay) — an unanswered AWS request can't silently vanish.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toHaveCount(1);
  });
});
