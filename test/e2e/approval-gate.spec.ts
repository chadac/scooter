/**
 * Tier 3 E2E for the approval gate: which option a viewer may use, and what they are told
 * when they may not. This is the browser half: the panel classifies an approval by contrib
 * name, asks the host per viewer, greys the option the manifest names, and shows that
 * contrib's own words; the host's answer is intercepted because the fast stack has no
 * broker, and the real-broker half lives in test/cluster/approvals.spec.ts. `echo` is the
 * subject because it declares different gating copy from aws, so reading the manifest and
 * falling back to aws's wording give distinguishable answers.
 */

import { test, expect } from "./fixtures.js";
import { fastOnly } from "./target.js";

const panel = {
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  message: '[data-testid="interrupt-message"]',
  hint: '[data-testid="interrupt-approve-hint"]',
};

/** echo's declared gating copy from contrib/echo/default.nix, deliberately not the option defaults. */
const ECHO_GATING = {
  gatedOption: "approve",
  blockedTitle: "Only a reviewer can approve an echo request.",
  blockedHint: "You can't approve this echo request — ask a reviewer.",
};

/** Serve a contrib manifest to the browser, since the fast stack's vite dev server has no /contrib/manifest.json. */
async function serveManifest(page: import("@playwright/test").Page, approvals: unknown) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sources: {}, toolCards: {}, toolTitles: {}, linkProviders: [], approvals }),
    }),
  );
}

/** Answer the panel's per-viewer can-approve check and record the URLs it asked for. */
function interceptCanApprove(page: import("@playwright/test").Page, canApprove: boolean, pending = true) {
  const asked: string[] = [];
  void page.route("**/can-approve", (route) => {
    asked.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ canApprove, pending }),
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
  // Assert here so a routing failure reports as itself rather than as a missing panel.
  expect(res.status(), `the approvals route must accept this (got ${res.status()})`).toBe(202);
  return res;
}

/** Every conversation id the server currently lists. */
async function conversationIds(
  request: import("@playwright/test").APIRequestContext,
  base: string,
): Promise<string[]> {
  const res = await request.get(`${base}/conversations`);
  if (!res.ok()) return [];
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * The id of the conversation this test just created, diffed from the server's own list
 * rather than read out of the UI's localStorage.
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

// fastOnly: the refusing branch needs a controlled can-approve answer, which on a cluster
// comes from a real authorizer.
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

      // The gated option is disabled and the other is not; refusing is never a privileged action.
      const approve = page.locator(panel.option).filter({ hasText: /approve/i });
      const deny = page.locator(panel.option).filter({ hasText: /deny/i });
      await expect(approve).toBeDisabled();
      await expect(deny).toBeEnabled();

      // echo's copy, not aws's.
      await expect(page.locator(panel.hint)).toHaveText(ECHO_GATING.blockedHint);
      await expect(approve).toHaveAttribute("title", ECHO_GATING.blockedTitle);

      // And it asked about the right contrib + request.
      expect(asked.some((u) => u.includes("/approvals/echo/"))).toBe(true);
    });

    test("says a request that is gone is no longer pending, not that an admin must approve", async ({ chat, page, baseURL, request }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await serveManifest(page, { echo: ECHO_GATING });
      interceptCanApprove(page, false, false);

      const before = await conversationIds(request, base);
      await chat.open();
      await chat.send("do something that needs approval");
      await chat.waitForReply(/dummy agent/i);
      const id = await newConversationId(page, request, base, before);
      await raiseApproval(request, base, id, "echo", `echo-${Date.now()}`, "Echo would like permission.");

      await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
      const approve = page.locator(panel.option).filter({ hasText: /approve/i });
      await expect(approve).toBeDisabled();
      await expect(page.locator(panel.hint)).toContainText("expired or was already answered");
      await expect(approve).toHaveAttribute("title", "This request is no longer pending.");
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
      // With no gating described, the option stays live and the broker remains the
      // enforcement point.
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

      // The option is still live, because nothing told the UI what to grey.
      await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toBeEnabled();
      await expect(page.locator(panel.hint)).toHaveCount(0);
    });

    test("never gates an ordinary tool permission", async ({ chat, page }) => {
      // A plain permission interrupt carries no contrib tag, so the panel must not ask about it.
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
      // The answer travels POST /agui { resume }; this asserts the user-visible half, and who
      // approved needs a real broker (test/cluster/approvals.spec.ts).
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
