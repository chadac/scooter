/**
 * Tier 3 E2E — the APPROVAL GATE: which option a viewer may use, and what they are
 * told when they may not.
 *
 * Never had coverage. The pieces were unit-tested individually — the classifier, the
 * can-approve route, the relay — and the whole still shipped two bugs that only a
 * test crossing the seams could see:
 *
 *   #649  the greyed-option check authorized the VIEWER while the relay that followed
 *         authorized the CONVERSATION. Both halves passed their own tests.
 *   #651  the gating copy was aws's, hardcoded in the panel, so a second integration
 *         could not be described at all.
 *
 * Scope here is the BROWSER half: the panel classifies an approval by contrib name,
 * asks the host per viewer, greys the option the MANIFEST names, and shows that
 * contrib's own words. The host's answer is intercepted rather than served by a real
 * broker — the fast stack has no broker (Postgres + agent-host + router, all Node).
 * The other half of the loop (a real broker, echo recording WHO approved) is
 * test/cluster/approvals.spec.ts, which runs where a broker exists.
 *
 * `echo` is the subject on purpose. Driving this with aws would prove only that
 * aws's own strings still work; echo declares DIFFERENT copy (contrib/echo/
 * default.nix), so reading the manifest and guessing aws's wording give different
 * answers and the test can tell them apart.
 */

import { test, expect } from "./fixtures.js";
import { fastOnly } from "./target.js";

const panel = {
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  message: '[data-testid="interrupt-message"]',
  hint: '[data-testid="interrupt-approve-hint"]',
};

/** echo's declared gating copy — contrib/echo/default.nix. Deliberately NOT the
 *  option defaults, so "read the manifest" and "fall back to aws's" differ. */
const ECHO_GATING = {
  gatedOption: "approve",
  blockedTitle: "Only a reviewer can approve an echo request.",
  blockedHint: "You can't approve this echo request — ask a reviewer.",
};

/** Serve a contrib manifest to the browser. The fast stack's vite dev server has no
 *  /contrib/manifest.json (nginx serves it from the UI image), so without this the
 *  panel sees an empty manifest — which is itself one of the cases below. */
async function serveManifest(page: import("@playwright/test").Page, approvals: unknown) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sources: {}, toolCards: {}, toolTitles: {}, linkProviders: [], approvals }),
    }),
  );
}

/** Answer the per-viewer can-approve check the panel makes. Also records the URLs it
 *  asked for, so a test can assert the panel addressed the right contrib. */
function interceptCanApprove(page: import("@playwright/test").Page, canApprove: boolean) {
  const asked: string[] = [];
  void page.route("**/can-approve", (route) => {
    asked.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ canApprove }),
    });
  });
  return asked;
}

/** Raise an approval on a conversation the way a contrib's broker half does. */
async function raiseApproval(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  conversationId: string,
  contrib: string,
  requestId: string,
  message: string,
) {
  const res = await request.post(
    `${base}/conversations/${encodeURIComponent(conversationId)}/approvals/${encodeURIComponent(contrib)}`,
    { headers: { "Content-Type": "application/json" }, data: { request_id: requestId, message } },
  );
  // Assert HERE so a routing/addressing failure reports as itself. Without this the
  // next line waits 30s for a panel that was never raised and blames the UI.
  expect(res.status(), `the approvals route must accept this (got ${res.status()})`).toBe(202);
  return res;
}

/**
 * THIS test's conversation id, confirmed to exist server-side.
 *
 * Two separate hazards, both of which produce a 404 from the approvals route that
 * looks like a broken route rather than a racy test:
 *
 *  - `currentId` is the stable LOCAL key. For a conversation created on its first
 *    send it is a placeholder the server never issued, so the server id lives beside
 *    it as `serverId` — poll until that appears rather than reading once.
 *  - even then, the id is only useful once the SERVER lists it. So confirm against
 *    GET /conversations before acting on it (suspended-recovery.spec.ts and
 *    aws-interrupt.spec.ts read it this way for the same reason).
 */
async function conversationIds(
  request: import("@playwright/test").APIRequestContext,
  base: string,
): Promise<string[]> {
  const res = await request.get(`${base}/conversations`);
  if (!res.ok()) return [];
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * The id of the conversation this test just created, from the SERVER.
 *
 * Deliberately not read out of the UI's localStorage. Two earlier versions of this
 * helper did, and both were wrong about the persisted shape in a different way — one
 * addressed a client-minted placeholder the server had never issued (404 from the
 * approvals route), the other insisted on a `serverId` that is only recorded when it
 * differs from the local key (so it never resolved at all). Each failure looked like
 * a broken route or a broken UI rather than a broken test.
 *
 * Diffing the server's own list has no such coupling: whatever the UI stores, the
 * conversation this send created is the id that WASN'T there before.
 */
async function newConversationId(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  base: string,
  before: readonly string[],
): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const fresh = (await conversationIds(request, base)).filter((id) => !before.includes(id));
    if (fresh.length) return fresh[0];
    await page.waitForTimeout(500);
  }
  expect(false, "the send never produced a conversation on the server").toBeTruthy();
  return "";
}

// fastOnly: the gate's REFUSING branch needs a controlled can-approve answer. On a
// cluster that answer comes from a real broker's authorizer, so forcing it would mean
// seeding OpenFGA tuples mid-test — a different test, in a different tier.
fastOnly("needs a controlled can-approve answer (no real authorizer to seed)")(
  "approval gate",
  () => {
    test.beforeEach(() => test.setTimeout(120_000));

    test("greys the gated option and shows THAT CONTRIB'S words", async ({ chat, page, baseURL, request }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await serveManifest(page, { echo: ECHO_GATING });
      const asked = interceptCanApprove(page, false);

      const before = await conversationIds(request, base);
      await chat.open();
      await chat.send("do something that needs approval");
      await chat.waitForReply(/dummy agent/i);
      const id = await newConversationId(page, request, base, before);
      expect(id, "the conversation must exist before raising an approval").toBeTruthy();

      await raiseApproval(request, base, id, "echo", `echo-${Date.now()}`, "Echo would like permission.");

      await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(panel.message)).toContainText("Echo would like permission.");

      // The gated option is disabled; the OTHER option is not. Refusing is never a
      // privileged action, so greying both would strand the user with no way out.
      const approve = page.locator(panel.option).filter({ hasText: /approve/i });
      const deny = page.locator(panel.option).filter({ hasText: /deny/i });
      await expect(approve).toBeDisabled();
      await expect(deny).toBeEnabled();

      // ECHO's copy, not aws's. This is the assertion that fails if the panel
      // hardcodes strings again.
      await expect(page.locator(panel.hint)).toHaveText(ECHO_GATING.blockedHint);
      await expect(approve).toHaveAttribute("title", ECHO_GATING.blockedTitle);

      // And it asked about the right contrib + request.
      expect(asked.some((u) => u.includes("/approvals/echo/"))).toBe(true);
    });

    test("leaves the option live when the viewer MAY approve", async ({ chat, page, baseURL, request }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await serveManifest(page, { echo: ECHO_GATING });
      interceptCanApprove(page, true);

      const before = await conversationIds(request, base);
      await chat.open();
      await chat.send("ask me again");
      await chat.waitForReply(/dummy agent/i);
      const id = await newConversationId(page, request, base, before);

      await raiseApproval(request, base, id, "echo", `echo-${Date.now()}`, "Echo asks politely.");
      await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

      await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toBeEnabled();
      await expect(page.locator(panel.hint)).toHaveCount(0);
    });

    test("does NOT grey when the manifest describes no gating for this contrib", async ({
      chat, page, baseURL, request,
    }) => {
      // A contrib the manifest doesn't cover, or a manifest that failed to load. The
      // option stays live and the broker remains the enforcement point — greying is a
      // courtesy that saves a doomed click, not the security boundary. Failing closed
      // HERE would mean a manifest fetch hiccup silently disables approving entirely.
      const base = (baseURL ?? "").replace(/\/$/, "");
      await serveManifest(page, {}); // no rows at all
      interceptCanApprove(page, false); // the host says no…

      const before = await conversationIds(request, base);
      await chat.open();
      await chat.send("ungated");
      await chat.waitForReply(/dummy agent/i);
      const id = await newConversationId(page, request, base, before);

      await raiseApproval(request, base, id, "echo", `echo-${Date.now()}`, "Echo, ungated.");
      await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

      // …and the option is STILL live, because nothing told the UI what to grey.
      await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toBeEnabled();
      await expect(page.locator(panel.hint)).toHaveCount(0);
    });

    test("never gates an ordinary tool permission", async ({ chat, page }) => {
      // A plain permission interrupt carries no contrib tag. If the panel asked about
      // it, an unrelated failure in the approvals path could grey out the agent's
      // normal tool prompts.
      await serveManifest(page, { echo: ECHO_GATING });
      const asked = interceptCanApprove(page, false);

      await chat.open();
      // The fake agent raises a tool-permission interrupt on ?pick.
      await chat.send("?pick");
      await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

      for (const opt of await page.locator(panel.option).all()) {
        await expect(opt).toBeEnabled();
      }
      expect(asked, "a tool permission must not trigger a can-approve check").toEqual([]);
    });

    test("answering the gate clears the panel", async ({ chat, page, baseURL, request }) => {
      // The answer travels POST /agui { resume: [...] } — the path that carried no
      // approver identity until #649. Here we assert the user-visible half: the
      // decision lands and the window goes away. WHO it was recorded as needs a real
      // broker (test/cluster/approvals.spec.ts).
      const base = (baseURL ?? "").replace(/\/$/, "");
      await serveManifest(page, { echo: ECHO_GATING });
      interceptCanApprove(page, true);

      const before = await conversationIds(request, base);
      await chat.open();
      await chat.send("please approve");
      await chat.waitForReply(/dummy agent/i);
      const id = await newConversationId(page, request, base, before);

      await raiseApproval(request, base, id, "echo", `echo-${Date.now()}`, "Echo needs a yes.");
      await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

      await page.locator(panel.option).filter({ hasText: /approve/i }).click();
      await expect(page.locator(panel.root)).toBeHidden({ timeout: 30_000 });
    });
  },
);
