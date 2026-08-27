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
import { isFull } from "./target.js";

const panel = {
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  message: '[data-testid="interrupt-message"]',
};

/** The server id of the conversation THIS test is looking at, polled rather than read once.
 *
 *  Named "first" historically; it is the CURRENT conversation, which on a shared backend is
 *  not the same thing as the first listed one. See the body for why that distinction cost a
 *  false "aws-request must revive an inactive conversation" failure.
 *
 *  Polled because the router aggregates GET /conversations over the READY agent-host pods
 *  and degrades to a PARTIAL — sometimes empty — list while pods churn (the platform dump
 *  for the failing run is full of "resume-on-missing-pod failed"). A single read that came
 *  back [] used to kill the test on `list[0].id` with a bare "Cannot read properties of
 *  undefined", which says nothing about the real cause. */
async function firstConversationId(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  page: import("@playwright/test").Page,
): Promise<string> {
  // THIS test's conversation, read from the UI's own persisted selection — NOT list[0].
  //
  // `/conversations` is ordered newest-first across the WHOLE fleet on the full target, so
  // index 0 is whatever conversation was created most recently by ANY spec sharing the
  // backend. These tests then suspended and AWS-requested a stranger's conversation, which
  // another spec's cleanState was free to delete in between — and the route correctly
  // answered 404 for a conversation that no longer existed. CI showed exactly that: the
  // suspend succeeded (the id was real then) and the aws-request that followed got a 404,
  // reported as "aws-request must revive an inactive conversation", a bug that was not
  // happening. suspended-recovery.spec.ts already reads the id this way for the same reason.
  //
  // `currentId` is the stable LOCAL key; the server id is recorded beside it as `serverId`
  // (for a conversation created on its first send, currentId is a placeholder the server
  // never issued, so suspending by it 404s).
  let id = "";
  for (let i = 0; i < 30 && !id; i++) {
    id =
      (await page.evaluate(() => {
        try {
          const raw = localStorage.getItem("kubenix-agent.sessions.v1");
          if (!raw) return "";
          const st = JSON.parse(raw) as {
            currentId?: string;
            sessions?: Array<{ id: string; serverId?: string }>;
          };
          return st.sessions?.find((s) => s.id === st.currentId)?.serverId ?? "";
        } catch {
          return "";
        }
      })) ?? "";
    if (!id) await page.waitForTimeout(1000);
  }
  expect(id, "the conversation this test created must have a server id").toBeTruthy();

  // Confirm the SERVER agrees it exists before the test acts on it. The router aggregates
  // GET /conversations over the READY pods and degrades to a PARTIAL — sometimes empty —
  // list while pods churn, so this is a retry, not a single read.
  for (let i = 0; i < 30; i++) {
    const res = await request.get(`${base}/conversations`);
    if (res.ok()) {
      const rows = (await res.json()) as Array<{ id: string }>;
      if (rows.some((r) => r.id === id)) return id;
    }
    await page.waitForTimeout(1000);
  }
  expect(false, `the conversation ${id} never appeared in the server's list`).toBeTruthy();
  return id;
}

/** POST the aws-request exactly like the broker's _notify_host does. */
async function requestAws(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  conversationId: string,
  requestId: string,
) {
  return request.post(`${base}/conversations/${encodeURIComponent(conversationId)}/aws-request`, {
    headers: { "Content-Type": "application/json" },
    timeout: 120_000, // the route may REVIVE (real sandbox resume on the full target) before its 202
    data: {
      request_id: requestId,
      target_account: "dev",
      risk_level: "low",
      policy_summary: "s3:GetObject on the state bucket",
      justification: "read terraform state",
    },
  });
}

/** Timeout for the API POSTs that do REAL cluster work server-side before replying.
 *  On the full target `/suspend` awaits the sandbox suspend and `/aws-request` /
 *  the `/agui` resume await a REVIVE (sandbox resume → ready pod, 10-30s measured
 *  at cluster pace; see stop-run.spec.ts:75) — past Playwright's 30s APIRequest
 *  default on arithmetic alone. The fake stack answers in milliseconds either way. */
const API_BUDGET_MS = 120_000;

test.describe("AWS approval interrupt", () => {
  // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). Each test funds a sandbox
  // provision (~15-25s cold) inside its first reply wait, and the suspend/revive
  // tests add a real sandbox suspend + resume (10-30s each) — summed with the
  // 30s panel waits that is 150-200s worst case, past the 60s default while
  // everything behaves. Assertions unchanged; only the ceiling.
  test.beforeEach(() => test.setTimeout(240_000));

  test("the approval panel appears when the broker requests AWS access", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();

    // A live conversation with an active bridge (a normal send builds it).
    await chat.send("start working on the terraform plan");
    await chat.waitForReply(/dummy agent/i);

    // The conversation id (== threadId). Grab it from the conversations list.
    const conversationId: string = await firstConversationId(request, base, page);
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

    const conversationId: string = await firstConversationId(request, base, page);

    // Suspend it (drops the in-memory bridge) — the idle-suspend / restart case.
    const susp = await request.post(`${base}/conversations/${encodeURIComponent(conversationId)}/suspend`, {
      timeout: API_BUDGET_MS, // awaits the REAL sandbox suspend on the full target
    });
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

    const conversationId: string = await firstConversationId(request, base, page);

    // Raise the AWS interrupt, then SUSPEND to drop the in-memory bridge (the rollout /
    // idle case). The panel is present (persisted), but the run is no longer live.
    const reqId = `awsreq-resume-${Date.now()}`;
    expect((await requestAws(request, base, conversationId, reqId)).status()).toBe(202);
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    expect(
      (
        await request.post(`${base}/conversations/${encodeURIComponent(conversationId)}/suspend`, {
          timeout: API_BUDGET_MS, // awaits the REAL sandbox suspend on the full target
        })
      ).ok(),
    ).toBeTruthy();

    // Answer the approval exactly like InterruptPanel.tsx does — POST /agui with resume[].
    // BEFORE the fix this never returns (0 bytes) and only unblocks when a proxy/socket
    // timeout kills the idle stream — i.e. it takes the full request timeout. The fix
    // revives + answers (or closes with RUN_ERROR), so it returns as soon as the revive
    // settles. ASSERT ON ELAPSED TIME: a hang resolves only at the request timeout; the
    // fix returns FAR sooner.
    //
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). The bounds are per-target
    // because the legitimate work differs by ~100x, not because the assertion does:
    //  - fast: no cluster, the revive is in-process → the fix is sub-second; 8s vs a
    //    20s hang cleanly separates fixed from broken.
    //  - full: the fix's revive is a REAL sandbox resume (10-30s to a ready pod, per
    //    the instrumented stop-run runs) before the stream can close (on this target
    //    the broker has no record of the fabricated request, so /aws/pending re-raises
    //    nothing and the stream closes with a prompt RUN_ERROR — still a framed,
    //    returned response, which is the property under test). 120s vs a 150s-timeout
    //    hang keeps the same fixed/broken separation at cluster pace.
    const hangTimeoutMs = isFull ? 150_000 : 20_000;
    const promptReturnMs = isFull ? 120_000 : 8_000;
    const started = Date.now();
    const resume = await request.post(`${base}/agui`, {
      headers: { "Content-Type": "application/json" },
      timeout: hangTimeoutMs, // the bug hangs to here; the fix returns FAR sooner.
      data: {
        threadId: conversationId,
        resume: [{ interruptId: reqId, status: "resolved", payload: { optionId: "approve" } }],
      },
    });
    const elapsed = Date.now() - started;
    expect(resume.ok(), "the resume POST must return, not hang").toBeTruthy();
    const body = await resume.text();
    // Well-formed SSE that actually carried a terminal/answer frame — not 0 bytes. (In the
    // fake stack, with no BROKER_URL, the revived bridge answers the re-raised interrupt;
    // on the full target the frame is the RUN_ERROR described above.)
    expect(body.length, "the resume stream must carry frames, not 0 bytes").toBeGreaterThan(0);
    // The decisive assertion: it RETURNED PROMPTLY (at its target's pace). A dormant-run
    // hang would only resolve at the request timeout.
    expect(elapsed, `resume took ${elapsed}ms — a hang would take ~${hangTimeoutMs}ms`).toBeLessThan(promptReturnMs);
  });

  test("the AWS approval panel is still present after a page reload", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("another terraform task");
    await chat.waitForReply(/dummy agent/i);

    const conversationId: string = await firstConversationId(request, base, page);
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
