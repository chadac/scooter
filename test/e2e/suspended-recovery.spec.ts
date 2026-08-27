/**
 * Tier 3 E2E — RECOVERED conversations: the suspended → revived user journey.
 *
 * The reported field bugs, none of which had e2e coverage:
 *   1. a NEW AWS approval raised after a revive never appears in the tab,
 *   2. events.integrity "totally fails" and the UI sits with the message hidden
 *      (no error, no revive) — a 404 backoff-polls SILENTLY forever,
 *   3. the sent message disappears from the thread, shows in the Queue tab, and
 *      is never flushed.
 *
 * Existing coverage misses this whole path. `revive.spec.ts` never suspends
 * anything (it only switches sidebar conversations and explicitly defers the real
 * path to Tier 2). `queue-durability.spec.ts` and `interrupt-queue-recovery.spec.ts`
 * are all live conversations — no POST /suspend anywhere. `aws-interrupt.spec.ts`
 * is the only spec that genuinely suspends, and it covers the broker-route revive
 * and the resume-doesn't-hang guard, not a NEW approval after the revive nor the
 * queue.
 *
 * These drive the REAL lifecycle: POST /conversations/:id/suspend (which drops the
 * bridge + pod exactly like the idle sweep / a rollout), then exercise the UI.
 */

import { test, expect } from "./fixtures.js";

const panel = {
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
};

/** The conversation the UI is ACTUALLY showing. Read it from the UI's own
 *  localStorage `currentId` rather than assuming `/conversations[0]` — the list is
 *  ordered newest-first across the WHOLE server, so a conversation left behind by
 *  another spec can sit at index 0 and we'd suspend the wrong one (then wait forever
 *  for a reply on a conversation nobody is looking at). Falls back to the list head
 *  only if the UI hasn't persisted a selection yet. */
async function currentConversationId(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  base: string,
): Promise<string> {
  // The SERVER's id for the selected conversation. `currentId` is the stable local KEY —
  // for a conversation created on its first send it is a placeholder the server never
  // issued, so suspending by it 404s. The server id is recorded alongside it.
  const fromUi = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem("kubenix-agent.sessions.v1");
      if (!raw) return null;
      const st = JSON.parse(raw) as {
        currentId?: string;
        sessions?: Array<{ id: string; serverId?: string }>;
      };
      const cur = st.sessions?.find((s) => s.id === st.currentId);
      return cur?.serverId ?? null;
    } catch {
      return null;
    }
  });
  if (fromUi) return fromUi;
  const list = await (await request.get(`${base}/conversations`)).json();
  const id: string = list[0].id;
  expect(id, "a conversation must exist to suspend").toBeTruthy();
  return id;
}

/** Suspend for real — drops the in-memory bridge and the sandbox pod. */
async function suspend(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  id: string,
) {
  const res = await request.post(`${base}/conversations/${encodeURIComponent(id)}/suspend`);
  expect(res.ok(), "suspend must succeed").toBeTruthy();
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
    data: {
      request_id: requestId,
      target_account: "dev",
      risk_level: "low",
      policy_summary: "s3:GetObject on the state bucket",
      justification: "read terraform state",
    },
  });
}

// CLUSTER-HONEST BUDGET, all three describes (see stop-run.spec.ts:75). Every test
// here funds TWO sandbox boots on the full target: the opening turn provisions a real
// sandbox (5-25s cold), suspend() destroys it, and the revive turn provisions a FRESH
// one (another 5-25s) before its exec + streamed reply can land. Worst case (mid-run
// suspend): open ~5s + boot ≤25s + queue work + suspend + boot ≤25s + two more turns
// ×~10s ≈ 110s of expected work — the 60s suite default is arithmetic-bound. 240s per
// test, matching client-server-identity.spec.ts's two-boot budget.
const TWO_BOOT_BUDGET = 240_000;

test.describe("recovered conversation — history + integrity stream", () => {
  test.setTimeout(TWO_BOOT_BUDGET);
  test("the integrity stream serves a SUSPENDED conversation (200, full history, no silent 404 loop)", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // Bug #2 at the transport level. A 404 here is invisible in the UI: the client
    // backoff-polls with NO banner and NO error (integrityAgent's "not-found" branch),
    // which is exactly "I sit on a page with my message hidden somewhere".
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("remember me across the nap");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    // NOTE: events.integrity is a LONG-LIVED SSE stream — it replays history, sends
    // `synced`, then stays open with 25s heartbeats. So we must read it INCREMENTALLY
    // and stop at `synced`; awaiting res.text() would block until the server closes
    // (i.e. never) and time out even on a perfectly healthy 200.
    const { body, status } = await page.evaluate(
      async ({ url }) => {
        const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
        if (!res.ok || !res.body) return { status: res.status, body: "" };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          if (acc.includes('"kind":"synced"')) break; // replay complete
        }
        await reader.cancel().catch(() => {});
        return { status: res.status, body: acc };
      },
      { url: `${base}/conversations/${encodeURIComponent(id)}/events.integrity` },
    );

    expect(status, "a suspended conversation must still be readable, not 404").toBe(200);
    expect(body, "history must replay off the durable log with no live pod").toContain(
      "remember me across the nap",
    );
    expect(body).toContain('"kind":"synced"');
  });

  test("opening a SUSPENDED conversation renders its history (not an empty thread)", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("history before suspend");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    // Reload onto the suspended conversation — the thread must paint from the log.
    // Deep-link with ?thread=<id> rather than a bare reload: the sidebar is shared
    // across specs, and a STARRED leftover conversation can win the restored
    // selection, leaving us asserting against a different (empty) thread.
    await page.goto(`/?thread=${encodeURIComponent(id)}`);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await expect(
      chat.userMessages().filter({ hasText: /history before suspend/i }),
      "a suspended conversation must render its history, not an empty thread",
    ).toHaveCount(1, { timeout: 30_000 });
  });
});

test.describe("recovered conversation — sending a message revives it", () => {
  test.setTimeout(TWO_BOOT_BUDGET); // see the arithmetic above
  test("a message sent to a SUSPENDED conversation is delivered and answered", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // Bug #3, the core of it: the send must auto-revive (promptByThread → revive)
    // and produce a reply. If the revive fails the UI shows nothing at all — the
    // RUN_ERROR rides the POST's own SSE body, which the client cancels unread.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("first turn");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    // Send into the suspended conversation exactly like the composer does.
    // NOTE: deliberately send + assert on THIS message's own text, not sendTurn.
    // sendTurn polls for assistantMessages().count() to GROW past a pre-send
    // baseline — but a suspend tears down and rebuilds the thread view, so the count
    // can RESET to 0 and never exceed the baseline (CI: "Expected > 1, Received 0").
    // Asserting on the unique message text is both race-free and count-independent.
    await chat.send("wake up and answer me");

    await expect(
      chat.userMessages().filter({ hasText: /wake up and answer me/i }),
      "the message sent to a suspended conversation must appear in the thread",
    ).toHaveCount(1, { timeout: 30_000 });

    // ...and it must actually RUN: a second assistant turn must exist.
    //
    // Selector note (two earlier attempts failed on CI, recorded so they aren't retried):
    //   - `ran echo: "<text>"` — that echo is the sandbox `echo` OUTPUT (not the sent
    //     text) and is streamed word-by-word, so it need not land in one text node.
    //   - chat.assistantMessages() — returned 0 while the user message rendered fine.
    //     Its selector is `.aui-assistant-message-content, .aui-md`, but the assistant
    //     markup carries NO such class: thread.tsx renders the root with
    //     data-slot="aui_assistant-message-root" (data-role="assistant"), and only the
    //     USER side has a real `.aui-user-message-content` class. `.aui-md` matches only
    //     when the reply renders markdown, which this turn need not.
    // So anchor on the data-slot the component actually emits — checked in the markup,
    // not guessed.
    // 90s, not 45: on the full target the revive provisions a FRESH sandbox pod
    // (suspend destroyed the first), so this reply sits behind a second cold boot
    // (≤25s) + exec + word-by-word streaming — ~40s of expected work when cold.
    await expect
      .poll(async () => page.locator('[data-slot="aui_assistant-message-root"]').count(), {
        timeout: 90_000,
      })
      .toBeGreaterThanOrEqual(2);
  });

  test("the message sent to a suspended conversation does NOT get stuck in the Queue tab", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // Bug #3's exact symptom. The UI shows an OPTIMISTIC queued row the instant you
    // send, and clears it only once the server confirms the text (in the queue
    // snapshot or as a folded user message — RuntimeProvider's push pump). A revive
    // that never lands leaves that row pinned FOREVER, because postAgui swallows
    // every POST failure so the composer's error path never fires.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("before the nap");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    await chat.send("this must not get stuck"); // see the sendTurn note above

    await chat.openQueueTab();
    // 60s, not 30: the row clears when the server confirms the text, which on the
    // full target can trail the revive's fresh sandbox boot (≤25s cold) + exec.
    await expect(
      chat.queuedMessages(),
      "the queue must DRAIN after the revive — a pinned row is the reported bug",
    ).toHaveCount(0, { timeout: 60_000 });
  });

  test("a conversation suspended MID-RUN with a queued message recovers without a phantom queue", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // The nastiest variant: items are sitting in the bridge's in-memory queue when the
    // bridge is torn down. suspend() drops the closure holding them, and revive() builds
    // a fresh empty queue — so nothing will ever drain the old items, while the last
    // persisted QUEUE_UPDATED still lists them.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    // 60s, not 20: the scenario requires the suspend to land while the run is STILL in
    // flight with the message in the bridge's in-memory queue. On the full target the exec
    // waits for a ready sandbox pod before the sleep starts, so a 20s run can be over by
    // the time we suspend — which quietly tests something else. Nothing waits for the
    // sleep (the test suspends mid-run and cleanState cancels), so this costs no time.
    await chat.startLongRun(60);
    await chat.sendWhileRunning("queued before the suspend");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    // Revive by sending — the conversation must come back USABLE, with no phantom
    // queued row left behind from the torn-down bridge. (Assert on the ECHO of this
    // specific message rather than /dummy agent/i, which already matches the earlier
    // turn's reply and would pass instantly without proving the revive ran.)
    await chat.send("after the suspend");
    await expect(
      page.getByText(/after the suspend/i).first(),
      "the post-suspend send must actually run on the revived conversation",
    ).toBeVisible({ timeout: 45_000 });

    // THE BUG THIS PINS: an item sitting in the bridge's in-memory queue when
    // suspend() tears the bridge down used to be dropped on the floor — stop() never
    // drained or re-queued it, and revive() built a BRAND-NEW bridge with an empty
    // queue. The observed event log was:
    //     QUEUE_UPDATED items=['queued before the suspend']
    //     QUEUE_UPDATED items=['after the suspend']      <- silently replaced
    // The message never ran and never surfaced an error — exactly the reported "my
    // message just sits somewhere hidden". suspend() now DRAINS the queue onto the
    // conversation's persisted meta and revive() RE-ENQUEUES it, so it actually runs.
    // 90s, not 45: the re-enqueued message has to run on the REVIVED conversation, which
    // means a fresh bridge and — on the full target — a sandbox exec that first waits for a
    // ready pod. That is the same cold-boot arithmetic every other revive assertion here
    // funds; 45s was the fake stack's number.
    await expect(
      page.getByText(/queued before the suspend/i).first(),
      "a message queued when the conversation was suspended must NOT be silently lost",
    ).toBeVisible({ timeout: 90_000 });

    // ONLY NOW assert the queue is empty. Checked AFTER the re-enqueued message has
    // run: while it is legitimately queued/draining the count is transiently 1, so an
    // earlier check would race the very behavior this test asserts. What must not
    // survive is a PHANTOM row — one no pump will ever drain.
    await chat.openQueueTab();
    await expect(
      chat.queuedMessages(),
      "no phantom queued row may survive the suspend/revive",
    ).toHaveCount(0, { timeout: 30_000 });
  });
});

test.describe("recovered conversation — approvals after a revive", () => {
  test.setTimeout(TWO_BOOT_BUDGET); // see the arithmetic above
  test("a NEW AWS approval raised AFTER a revive appears in the tab", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // Bug #1. The existing aws-interrupt spec raises the approval BEFORE suspending;
    // the reported failure is a brand-new approval on an ALREADY-revived conversation,
    // whose bridge is a different instance than the one the tab first attached to.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("terraform work");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    // Revive via a normal send (the real user path), THEN raise a fresh approval.
    await chat.send("continue the plan"); // see the sendTurn note above

    const res = await requestAws(request, base, id, `awsreq-post-revive-${Date.now()}`);
    expect(res.status(), "the aws-request must be accepted on the revived conversation").toBe(202);

    // 90s, not 30: the request is accepted (202 asserted above), so what this waits on is
    // the interrupt reaching the BROWSER — which after a revive means the tab's stream
    // reattaching to a brand-new bridge instance on whichever pod now owns the
    // conversation. On the full target that hop sits behind the revive's own sandbox wait,
    // so 30s can expire with the approval correctly raised and simply not delivered yet.
    // Same cold-boot arithmetic every other revive assertion in this file funds.
    await expect(
      page.locator(panel.root),
      "an approval raised after a revive must appear — the reported invisible-approval bug",
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toHaveCount(1);
  });

  test("an approval raised after a revive survives a reload (it is durable, not bridge-only)", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // An interrupt that lives only in the new bridge's memory is invisible to any tab
    // that connects later. It must be in the durable log so the replay re-derives it.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("infra task");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);
    // Revive by sending, and WAIT for that turn to finish before reloading. The
    // previous version reloaded while the revive run was still in flight, and the
    // composer never mounted on CI (30s, element not found) — the passing reload test
    // in aws-interrupt.spec.ts always reloads from an IDLE app. waitForIdle polls the
    // run-status bar, so it is count- and text-independent (both of which have already
    // misfired in this file).
    await chat.send("resume the infra task");
    // 90s, not 45: this idle-wait spans the revive's fresh sandbox boot (≤25s cold)
    // + exec + streamed reply + the trailing terminal event on the full target.
    await chat.waitForIdle(90_000);

    const raised = await requestAws(request, base, id, `awsreq-durable-${Date.now()}`);
    expect(
      raised.status(),
      `aws-request must be accepted on the revived conversation (got ${raised.status()}: ${await raised.text().catch(() => "")})`,
    ).toBe(202);
    // 90s: identical post-revive delivery hop as the test above — the approval is accepted
    // (202 asserted) and this waits on it reaching the tab through a rebuilt bridge.
    await expect(
      page.locator(panel.root),
      "the approval must appear on the revived conversation before we test reload durability",
    ).toBeVisible({ timeout: 90_000 });

    // Plain reload (the pattern aws-interrupt.spec.ts uses for exactly this
    // assertion). A `?thread=` deep-link left the composer unmounted on CI — the
    // conversation is already selected here, so there is nothing to deep-link to.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 30_000 });
    // After a reload the Approvals tab is NOT auto-focused: RightPanel only steals
    // focus when the pending count RISES, and a replayed approval is already counted
    // on first render. So select the tab explicitly (as the other interrupt specs do)
    // — the assertion here is that the approval SURVIVED, not that it grabs focus.
    await page.locator(panel.approvalsTab).click();
    await expect(
      page.locator(panel.root),
      "the post-revive approval must replay from the log after a reload",
    ).toBeVisible({ timeout: 30_000 });
  });

  test("answering an approval on a conversation suspended AFTER it was raised resolves promptly", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // The approval is raised, the conversation goes to sleep, and the user answers from
    // a tab that was open the whole time. The answer must revive + route (or fail
    // loudly) — never hang until a proxy 502s it.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("apply the terraform");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    const reqId = `awsreq-answer-${Date.now()}`;
    expect((await requestAws(request, base, id, reqId)).status()).toBe(202);
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

    await suspend(request, base, id);

    // Answer via the SAME POST /agui { resume:[…] } the InterruptPanel issues. (We
    // don't click the button here: in this stack the AWS Approve control is gated on
    // an admin approver — `data-blocked` / "You need an admin to approve this request"
    // — so a click asserts authorization, not recovery. The resume POST is the path
    // whose revive-before-answer behavior this test is about.)
    const started = Date.now();
    const resume = await request.post(`${base}/agui`, {
      headers: { "Content-Type": "application/json" },
      timeout: 20_000, // the historical bug hangs to here; a healthy revive returns fast
      data: {
        threadId: id,
        resume: [{ interruptId: reqId, status: "resolved", payload: { optionId: "approve" } }],
      },
    });
    const elapsed = Date.now() - started;

    expect(resume.ok(), "the resume POST must return, not hang").toBeTruthy();
    const body = await resume.text();
    expect(body.length, "the resume stream must carry frames, not 0 bytes").toBeGreaterThan(0);
    // The decisive assertion: it RETURNED PROMPTLY. A dormant-run hang only resolves at
    // the request timeout; the revive-before-answer path is sub-second on the fake
    // stack. 12s (not 8) on cluster reality: the POST hops through the router and the
    // revive spawns a fresh bridge/agent process first — but it does NOT wait for a
    // sandbox pod, so a healthy answer still lands far under the 20s hang ceiling.
    expect(elapsed, `resume took ${elapsed}ms — a hang would run to the ~20s timeout`).toBeLessThan(12_000);
  });
});
