/**
 * Tier 3 E2E (FULL / multi-pod only) — "open a second tab, the first goes silent."
 *
 * This is the REPRODUCTION for the two-tabs-one-goes-silent report. The existing UI-level two-tab
 * spec (concurrency-divergence.spec.ts) opens two tabs and asserts they CONVERGE on the same
 * transcript — and it passes on the 3-pod CI cluster. That is exactly why it does NOT catch this
 * bug: the failure is a TRANSIENT one. A co-viewer's integrity stream is served by a NON-owner
 * pod, so after replay it emits `: owner-elsewhere — reconnect` and ENDS (see the ownership block
 * in agent-host `management.ts`); live appends only ever reach the OWNER pod's local store. The UI
 * then silently reconnects through the router and (once routing converges) lands back on the
 * owner — so a convergence assertion with a 45s poll swallows the gap entirely. The user sees the
 * gap: the first tab stops updating until it re-homes.
 *
 * So this spec does NOT assert final convergence. It opens TWO concurrent raw `events.integrity`
 * SSE connections for the SAME conversation (two real router requests, exactly as two browser tabs
 * produce), keeps BOTH open across a live append, and asserts the mechanism directly:
 *   - both replay history and reach `synced`;
 *   - NEITHER is ended with `owner-elsewhere` after syncing (the silencing signature);
 *   - the live append reaches BOTH streams, not just one.
 *
 * WHY multi-pod only: on the single-pod fake stack every stream is served by the sole owner pod,
 * so `streamOwnership` is always "mine" and the bug structurally cannot occur. It needs ≥2
 * agent-host pods (CI runs 3, podCap=1) AND a window where the conversation's routing address
 * (status.hostIP) is stale/missing, so the router's ClusterIP fallback can scatter the second
 * connection onto a non-owner pod. conversation-controller PR #479 (RepairHostIP) closes that
 * window by converging hostIP while the owner stays ready — with it applied, both connections
 * route to the owner and this spec passes.
 *
 * DETERMINISM (honest): this catches a REGRESSION that ends a co-viewer's stream, and it passes on
 * a correctly-converged cluster. It cannot force the exact scatter race on demand — whether the
 * pre-fix path fires depends on hostIP being unconverged at the instant the second connection
 * routes. It opens both streams as early as history allows to widen that window, but a green run
 * on old code is "the race didn't hit this time", not "the bug is absent". The deterministic guard
 * for the mechanism lives at the contract level (integrityRoute.spec.ts ownership cases) and the
 * controller level (test_reconcile.py hostIP convergence).
 */

import { test, expect, type Chat } from "./fixtures.js";
import { fullOnly } from "./target.js";

/** One raw integrity connection's outcome, gathered inside the browser. */
type StreamResult = {
  tag: string;
  status: number;
  synced: boolean; // replay reached `{"kind":"synced"}`
  ownerElsewhere: boolean; // saw the `: owner-elsewhere` close marker
  ended: boolean; // the SSE body ended (done) before our window elapsed
  sawAppend: boolean; // the live-append probe text arrived on THIS stream
  bytes: number;
};

/**
 * Open TWO concurrent `events.integrity` streams for `id` from the SAME browser origin (so each is
 * a real router request, routed independently — just like two tabs), read both until `windowMs`
 * elapses, and report each one's outcome. `probe` is the unique text of the live append we expect
 * BOTH to receive; the append itself is driven from the other page while this evaluate runs.
 */
async function openTwoStreams(
  page: import("@playwright/test").Page,
  url: string,
  probe: string,
  windowMs: number,
): Promise<{ a: StreamResult; b: StreamResult }> {
  return page.evaluate(
    async ({ url, probe, windowMs }) => {
      async function read(tag: string): Promise<StreamResult> {
        const out: StreamResult = {
          tag,
          status: 0,
          synced: false,
          ownerElsewhere: false,
          ended: false,
          sawAppend: false,
          bytes: 0,
        };
        const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
        out.status = res.status;
        if (!res.ok || !res.body) {
          out.ended = true;
          return out;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const deadline = Date.now() + windowMs;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) {
            out.ended = true; // server closed the stream — the silencing signature
            break;
          }
          const chunk = dec.decode(value, { stream: true });
          out.bytes += chunk.length;
          if (chunk.includes('"kind":"synced"')) out.synced = true;
          if (chunk.includes("owner-elsewhere")) out.ownerElsewhere = true;
          if (chunk.includes(probe)) out.sawAppend = true;
        }
        await reader.cancel().catch(() => {});
        return out;
      }
      // Both open in the SAME tick, mirroring a second tab opened onto a live first tab.
      const [a, b] = await Promise.all([read("A"), read("B")]);
      return { a, b };
      // The StreamResult type is redeclared structurally here because page.evaluate runs in the
      // browser realm, which cannot see the Node-side type import.
    },
    { url, probe, windowMs },
  ) as Promise<{ a: StreamResult; b: StreamResult }>;
}

fullOnly("multi-pod routing")(
  "two concurrent integrity streams (second tab must not silence the first)",
  () => {
    // Budget: a seed completeTurn funds a cold sandbox boot (≤25s) + the run, then the two streams
    // stay open across a ~60s append window driven by a second send. Matches suspended-recovery's
    // two-boot budget with headroom for the stream window.
    test.beforeEach(() => test.setTimeout(300_000));

    test("a live append reaches BOTH open streams and neither is closed with owner-elsewhere", async ({
      chat,
      page,
      context,
      baseURL,
      request,
    }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await chat.open();
      // Seed: create the conversation + give it history and an assigned owner pod.
      await chat.completeTurn("seed turn so the conversation has history + an owner");
      // The SERVER's id (not the client placeholder in ?thread) — the integrity endpoint keys on
      // it, so a placeholder would 404. Same resolution suspended-recovery.spec.ts uses.
      const id = await serverConversationId(page, request, base);

      const integrityUrl = `${base}/conversations/${encodeURIComponent(id)}/events.integrity`;
    const probe = `live-append-${Date.now()}`;

    // The two raw streams run on a SEPARATE page so this page.evaluate does not block the send we
    // drive on `page`. They open concurrently, sync, then stay open for the whole window.
    const readerPage = await context.newPage();
    const windowMs = 60_000;
    const streams = openTwoStreams(readerPage, integrityUrl, probe, windowMs);

    // Give both streams a beat to open + replay + go live, THEN emit the live append on tab A.
    await page.waitForTimeout(4_000);
    await sendProbe(chat, page, probe);

    const { a, b } = await streams;
    await readerPage.close();

    // Both must have replayed history (readable from any pod via the mirror).
    expect(a.status, "stream A opened").toBe(200);
    expect(b.status, "stream B opened").toBe(200);
    expect(a.synced && b.synced, "both streams must replay to synced").toBe(true);

    // THE BUG: a co-viewer's stream ended with owner-elsewhere after syncing → it goes silent and
    // the client must reconnect. On a converged (hostIP-repaired) cluster this never happens.
    expect(
      a.ownerElsewhere || b.ownerElsewhere,
      "no open stream may be closed with owner-elsewhere (that is the silencing bug)",
    ).toBe(false);
    expect(a.ended || b.ended, "neither stream may be ended by the server while both are open").toBe(false);

    // The payoff: the live append must reach BOTH streams, not just the one on the owner pod.
    expect(
      a.sawAppend && b.sawAppend,
      `the live append (${probe}) must reach BOTH streams — A:${a.sawAppend} B:${b.sawAppend}`,
    ).toBe(true);
  });
});

/** The SERVER's id for the currently-selected conversation. A conversation created on its first
 *  send carries a client-side placeholder in `?thread`; the server id is recorded alongside it in
 *  localStorage. The integrity endpoint keys on the server id (a placeholder 404s), so resolve it
 *  from localStorage first and fall back to GET /conversations. Mirrors suspended-recovery.spec.ts. */
async function serverConversationId(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  base: string,
): Promise<string> {
  const fromUi = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem("kubenix-agent.sessions.v1");
      if (!raw) return null;
      const st = JSON.parse(raw) as {
        currentId?: string;
        sessions?: Array<{ id: string; serverId?: string }>;
      };
      return st.sessions?.find((s) => s.id === st.currentId)?.serverId ?? null;
    } catch {
      return null;
    }
  });
  if (fromUi) return fromUi;
  const list = (await (await request.get(`${base}/conversations`)).json()) as Array<{ id: string }>;
  expect(list[0]?.id, "a conversation must exist for the integrity stream").toBeTruthy();
  return list[0].id;
}

/** Emit a live append the two open streams must both observe: send a turn and confirm the user
 *  message landed on THIS tab (the append fires on the owner's store immediately; we don't wait for
 *  the full agent reply, which would blow the stream window). */
async function sendProbe(chat: Chat, page: import("@playwright/test").Page, probe: string): Promise<void> {
  await chat.send(probe);
  await expect(
    page.locator(".aui-user-message-content").filter({ hasText: probe }),
    "the probe turn must land on the sending tab",
  ).toHaveCount(1, { timeout: 45_000 });
}
