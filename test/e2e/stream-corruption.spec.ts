/**
 * Tier 3 E2E — HOSTILE integrity-stream conditions.
 *
 * The previous passes proved the UI is coherent when the stream behaves. This spec attacks the
 * stream itself: frames that arrive TWICE, OUT OF ORDER, MALFORMED, TRUNCATED, with a BROKEN
 * CHECKSUM, or carrying an UNKNOWN event type. The client keeps reading throughout — so unlike a
 * drop/kill (where recovery is a reconnect), the failure mode here is a POISONED FOLD: the UI
 * renders something wrong and never notices.
 *
 * Every test asserts the whole-UI invariants (assertConsistent) plus, critically, that the
 * transcript matches the SERVER's own view (assertMatchesServer) — a UI that quietly diverges from
 * the agent-host is exactly the "weird detached state" being hunted.
 *
 * Runs on the isolated fault-proxy stack (baseURL 5273, fast idle-watchdog).
 */

import { test, expect, snapshot, assertConsistent, assertMatchesServer } from "./fixtures.js";
import { tier3Only } from "./tier.js";
import type { APIRequestContext } from "@playwright/test";

const PROXY = "http://localhost:8090";
async function setFault(request: APIRequestContext, fault: Record<string, unknown>) {
  const res = await request.post(`${PROXY}/__fault`, { data: fault });
  expect(res.ok()).toBeTruthy();
}
async function clearFault(request: APIRequestContext) {
  await setFault(request, { mode: "none" });
}

tier3Only("needs the SSE fault proxy to corrupt stream frames")("integrity stream corruption", () => {
  test.use({ baseURL: "http://localhost:5273" });
  test.afterEach(async ({ request }) => { await clearFault(request); });

  test("a DUPLICATED text frame must not duplicate the rendered message (idempotent fold)", async ({ chat, page, request, baseURL }) => {
    await chat.open();
    await chat.completeTurn("establish a healthy baseline");
    const before = await snapshot(page);

    // Re-deliver TEXT_MESSAGE_CONTENT three extra times: at-least-once redelivery on the wire.
    await setFault(request, { mode: "duplicate", eventType: "TEXT_MESSAGE_CONTENT", n: 3 });
    await chat.completeTurn("duplicated frames incoming");

    const after = await snapshot(page);
    assertConsistent(after, "after duplicated frames");
    // Exactly ONE new user turn and ONE new reply — redelivery must not inflate the transcript.
    expect(after.userMessages, "a duplicated frame must not duplicate the user turn").toBe(before.userMessages + 1);
    expect(after.assistantMessages, "a duplicated frame must not duplicate the reply").toBe(before.assistantMessages + 1);
    await assertMatchesServer(page, request, baseURL, "after duplicated frames");
  });

  test("a DUPLICATED tool-call frame must not render the tool card twice", async ({ chat, page, request }) => {
    await chat.open();
    // Baseline turn (also runs a tool) so the fault lands on a live stream — so measure the DELTA in
    // tool cards, not the absolute count.
    await chat.completeTurn("!echo healthy baseline before the fault");
    const before = await snapshot(page);
    await setFault(request, { mode: "duplicate", eventType: "TOOL_CALL_START", n: 2 });
    await chat.completeTurn("!echo duplicate my tool call");

    const s = await snapshot(page);
    assertConsistent(s, "after a duplicated tool frame");
    expect(
      s.toolCards - before.toolCards,
      "one tool call renders exactly ONE new card, however many times its frame arrives",
    ).toBe(1);
  });

  test("OUT-OF-ORDER frames must not corrupt the transcript or wedge the run", async ({ chat, page, request, baseURL }) => {
    await chat.open();
    await chat.completeTurn("baseline before reordering");
    const before = await snapshot(page);

    // Hold TEXT_MESSAGE_START and release it AFTER the following frame — content before start.
    await setFault(request, { mode: "reorder", eventType: "TEXT_MESSAGE_START" });
    await chat.completeTurn("frames arrive out of order");

    const after = await snapshot(page);
    assertConsistent(after, "after out-of-order frames");
    expect(after.assistantMessages, "the reply still lands exactly once").toBe(before.assistantMessages + 1);
    expect(after.runError, "reordering must not surface a user-facing error").toBeNull();
    await assertMatchesServer(page, request, baseURL, "after out-of-order frames");
  });

  test("a MALFORMED (unparseable) frame is skipped — the run still completes", async ({ chat, page, request, baseURL }) => {
    await chat.open();
    // Establish a healthy conversation FIRST: a fault armed before any stream exists lands on the
    // conversation's very first connection, so the send never gets through and the test proves nothing.
    await chat.completeTurn("healthy baseline before the fault");
    const before = await snapshot(page);
    await setFault(request, { mode: "garbage", afterN: 2 });
    await chat.completeTurn("garbage frame mid-stream");

    const s = await snapshot(page);
    assertConsistent(s, "after a malformed frame");
    expect(s.assistantMessages, "a junk frame must not swallow the reply").toBeGreaterThan(before.assistantMessages);
    expect(s.composerSendable, "the composer must not wedge on a junk frame").toBe(true);
    await assertMatchesServer(page, request, baseURL, "after a malformed frame");
  });

  test("a TRUNCATED frame (torn mid-JSON) must not wedge or poison the fold", async ({ chat, page, request }) => {
    await chat.open();
    // Establish a healthy conversation FIRST: a fault armed before any stream exists lands on the
    // conversation's very first connection, so the send never gets through and the test proves nothing.
    await chat.completeTurn("healthy baseline before the fault");
    const before = await snapshot(page);
    await setFault(request, { mode: "truncate", afterN: 2 });
    await chat.completeTurn("truncated frame incoming");

    const s = await snapshot(page);
    assertConsistent(s, "after a truncated frame");
    expect(s.assistantMessages, "the turn still completes despite a torn frame").toBeGreaterThan(before.assistantMessages);
    expect(s.composerSendable, "the composer recovers").toBe(true);
  });

  test("an UNKNOWN event type is ignored gracefully (forward compatibility)", async ({ chat, page, request, baseURL }) => {
    await chat.open();
    // Establish a healthy conversation FIRST: a fault armed before any stream exists lands on the
    // conversation's very first connection, so the send never gets through and the test proves nothing.
    await chat.completeTurn("healthy baseline before the fault");
    const before = await snapshot(page);
    await setFault(request, { mode: "bogusEvent", afterN: 2 });
    await chat.completeTurn("unknown event type incoming");

    const s = await snapshot(page);
    assertConsistent(s, "after an unknown event type");
    expect(s.assistantMessages, "an unknown event must not break the turn").toBeGreaterThan(before.assistantMessages);
    expect(s.runError, "an unknown event is not a user-facing error").toBeNull();
    await assertMatchesServer(page, request, baseURL, "after an unknown event type");
  });

  test("a CORRUPTED CHECKSUM must not leave the UI silently diverged from the server", async ({ chat, page, request, baseURL }) => {
    await chat.open();
    await chat.completeTurn("baseline before checksum corruption");

    // Break the integrity chain mid-stream. Whatever the client does about it (re-sync, refetch), the
    // end state must still agree with the server — the whole point of the checksum.
    await setFault(request, { mode: "corruptChecksum", afterN: 2 });
    await chat.completeTurn("checksum will be corrupted");

    const s = await snapshot(page);
    assertConsistent(s, "after checksum corruption");
    await assertMatchesServer(page, request, baseURL, "after checksum corruption");
  });

  test("corruption DURING a queued message must not lose the queued turn", async ({ chat, page, request, baseURL }) => {
    // Real end-to-end work (a run draining behind a queued turn) needs more than the 60s suite
    // default — the 90s polls below were otherwise silently capped by the TEST budget, so a slower
    // CI runner failed the test while the poll still had time left on paper.
    test.setTimeout(180_000);
    await chat.open();
    await chat.send("!sleep 4");
    await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    await chat.sendWhileRunning("queued through the corruption");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 20_000 });

    // Corrupt the stream WHILE a message waits in the queue — the riskiest moment.
    await setFault(request, { mode: "duplicate", eventType: "RUN_FINISHED", n: 2 });
    await expect.poll(async () => (await snapshot(page)).queued.length, { timeout: 90_000 }).toBe(0);
    await chat.waitForIdle(90_000);

    const s = await snapshot(page);
    assertConsistent(s, "after corruption during a queued turn");
    expect(
      await page.locator(".aui-user-message-content").filter({ hasText: "queued through the corruption" }).count(),
      "the queued message ran EXACTLY once despite duplicated terminal frames",
    ).toBe(1);
    await assertMatchesServer(page, request, baseURL, "after corruption during a queued turn");
  });

  test("repeated corruption across SEVERAL turns keeps the transcript exact", async ({ chat, page, request, baseURL }) => {
    await chat.open();
    await chat.completeTurn("healthy baseline before the fault");
    const kinds: Array<Record<string, unknown>> = [
      { mode: "duplicate", eventType: "TEXT_MESSAGE_CONTENT", n: 2 },
      { mode: "garbage", afterN: 2 },
      { mode: "bogusEvent", afterN: 2 },
      { mode: "truncate", afterN: 3 },
    ];
    for (let i = 0; i < kinds.length; i++) {
      await setFault(request, kinds[i]);
      await chat.completeTurn(`hostile turn ${i + 1}`, 60_000);
      const s = await snapshot(page);
      assertConsistent(s, `hostile turn ${i + 1}`);
      // The transcript grows by EXACTLY one turn per send, whatever the stream did.
      // +1 for the healthy baseline turn established before the faults.
      expect(s.userMessages, `hostile turn ${i + 1}: exact user count`).toBe(i + 2);
      expect(s.assistantMessages, `hostile turn ${i + 1}: exact assistant count`).toBe(i + 2);
    }
    await assertMatchesServer(page, request, baseURL, "after four hostile turns");
  });
});
