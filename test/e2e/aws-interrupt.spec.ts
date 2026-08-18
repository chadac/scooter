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

  test("ANSWERING via /agui resume returns (does not hang) after the bridge was dropped", async ({ chat, page, baseURL, request }) => {
    // THE reported bug (docs/scooter-bug-resume-hangs-when-run-not-live.md): after a
    // rollout / idle-suspend, the paused run is gone from memory. The user's Approve
    // POSTs /agui { resume:[…] }, but onResume no-ops on the bridge-less conversation and
    // the SSE is left OPEN with 0 bytes → the request hangs until a proxy 502s it and the
    // approval can never complete. The fix REVIVES + re-raises before answering, and the
    // resume branch closes with a RUN_ERROR rather than hanging if it still can't answer.
    // Either way the POST must RETURN promptly — never a 0-byte indefinite stream.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("terraform apply needing AWS");
    await chat.waitForReply(/dummy agent/i);

    const list = await (await request.get(`${base}/conversations`)).json();
    const conversationId: string = list[0].id;

    // Raise the AWS interrupt, then SUSPEND to drop the in-memory bridge (the rollout /
    // idle case). The panel is present (persisted), but the run is no longer live.
    const reqId = `awsreq-resume-${Date.now()}`;
    expect((await requestAws(request, base, conversationId, reqId)).status()).toBe(202);
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    expect((await request.post(`${base}/conversations/${encodeURIComponent(conversationId)}/suspend`)).ok()).toBeTruthy();

    // Answer the approval exactly like InterruptPanel.tsx does — POST /agui with resume[].
    // BEFORE the fix this never returns (0 bytes) and only unblocks when a proxy/socket
    // timeout kills the idle stream — i.e. it takes the full request timeout. The fix
    // revives + answers (or closes with RUN_ERROR), so it returns in well under a second.
    // ASSERT ON ELAPSED TIME: a hang resolves only at the ~15s+ timeout; the fix is
    // sub-second. A generous 8s ceiling cleanly separates fixed (fast) from broken (hang).
    const started = Date.now();
    const resume = await request.post(`${base}/agui`, {
      headers: { "Content-Type": "application/json" },
      timeout: 20_000, // the bug hangs to here; the fix returns FAR sooner.
      data: {
        threadId: conversationId,
        resume: [{ interruptId: reqId, status: "resolved", payload: { optionId: "approve" } }],
      },
    });
    const elapsed = Date.now() - started;
    expect(resume.ok(), "the resume POST must return, not hang").toBeTruthy();
    const body = await resume.text();
    // Well-formed SSE that actually carried a terminal/answer frame — not 0 bytes. (In the
    // fake stack, with no BROKER_URL, the revived bridge answers the re-raised interrupt.)
    expect(body.length, "the resume stream must carry frames, not 0 bytes").toBeGreaterThan(0);
    // The decisive assertion: it RETURNED PROMPTLY. A dormant-run hang would only resolve
    // at the request timeout (~20s); the fix returns in well under a second.
    expect(elapsed, `resume took ${elapsed}ms — a hang would take ~20s`).toBeLessThan(8_000);
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
