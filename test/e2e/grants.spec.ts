/**
 * Tier 3 E2E for the Grants section of the Approvals tab. The fake stack has no broker,
 * so the real agent-host answers an empty list; the populated cases serve the
 * agent-host's GET /conversations/:id/grants and capture the verb POSTs the UI sends.
 */

import { type Page, type Route } from "@playwright/test";
import { test, expect, shot } from "./fixtures.js";

const sel = {
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
  section: '[data-testid="grants-section"]',
  empty: '[data-testid="grants-empty"]',
  grant: '[data-testid="grant"]',
  inactiveToggle: '[data-testid="grants-inactive-toggle"]',
  inactive: '[data-testid="grants-inactive"]',
  verb: '[data-testid="grant-verb"]',
  preset: '[data-testid="grant-preset"]',
};

const MIN = 60_000;

function grants(now: number) {
  return [
    {
      contrib: "k8s", id: "g-web", title: "Write to prod/web", status: "active",
      scope: ["cluster prod", "namespace web", "apply, delete, scale, rollout restart"],
      granted_by: "alice@example.com", granted_at: now - 18 * MIN, expires_at: now + 42 * MIN,
      verbs: [
        { verb: "extend", label: "Extend", presets_minutes: [15, 30, 60], allowed: true },
        { verb: "pin", label: "Indefinite", presets_minutes: [], allowed: true },
        { verb: "revoke", label: "Revoke", presets_minutes: [], allowed: true },
      ],
    },
    {
      contrib: "aws", id: "r-s3", title: "AWS access to data-prod", status: "active",
      scope: ["account data-prod", "medium risk", "s3:GetObject, s3:PutObject on arn:aws:s3:::reports/*"],
      granted_by: "bob@example.com", granted_at: now - 3 * 60 * MIN, expires_at: null,
      verbs: [{ verb: "revoke", label: "Revoke", presets_minutes: [], allowed: false }],
    },
    {
      contrib: "k8s", id: "g-api", title: "Write to prod/api", status: "expired",
      scope: ["cluster prod", "namespace api", "apply, delete, scale, rollout restart"],
      granted_by: "alice@example.com", granted_at: now - 4 * 60 * MIN, expires_at: now - 2 * 60 * MIN,
      verbs: [{ verb: "revive", label: "Revive", presets_minutes: [15, 30, 60], allowed: true }],
    },
    {
      contrib: "aws", id: "r-ec2", title: "AWS access to sandbox", status: "revoked",
      scope: ["account sandbox", "high risk", "ec2:*"],
      granted_by: "alice@example.com", granted_at: now - 26 * 60 * MIN, expires_at: now + 60 * MIN,
      ended_at: now - 25 * 60 * MIN, ended_by: "alice@example.com",
      verbs: [{ verb: "revive", label: "Revive", presets_minutes: [60, 240, 480, 720], allowed: true }],
    },
  ];
}

/** Serve the grants list and record each verb the UI posts. */
async function serveGrants(page: Page): Promise<Array<{ url: string; body: unknown }>> {
  const posted: Array<{ url: string; body: unknown }> = [];
  const now = Date.now();
  await page.route(/\/conversations\/[^/]+\/grants(\/.*)?$/, async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST") {
      posted.push({ url: new URL(req.url()).pathname, body: req.postDataJSON() });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grant: {} }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: grants(now) }) });
  });
  return posted;
}

async function openApprovals(chat: { open(): Promise<void>; send(t: string): Promise<void>; waitForReply(r: RegExp): Promise<void> }, page: Page) {
  await chat.open();
  await chat.send("deploy the fix");
  await chat.waitForReply(/dummy agent/i);
  await page.locator(sel.approvalsTab).click();
}

test.describe("grants in the Approvals tab", () => {
  test("a conversation with no grants says so, from the real agent-host", async ({ chat, page }) => {
    await openApprovals(chat, page);
    await expect(page.locator(sel.empty)).toBeVisible({ timeout: 30_000 });
  });

  test("active grants list first, inactive ones collapse, and verbs post to the host", async ({ chat, page }) => {
    const posted = await serveGrants(page);
    await openApprovals(chat, page);
    const section = page.locator(sel.section);
    await expect(section.locator(sel.grant)).toHaveCount(2, { timeout: 30_000 });
    await expect(section.locator(sel.grant).first()).toContainText("Write to prod/web");
    await expect(section.locator(sel.grant).first()).toContainText(/Expires in 4[12]m/);
    await expect(section.locator(sel.grant).nth(1)).toContainText("Indefinite");
    await shot(page, "grants active");

    // A viewer who couldn't approve the original sees it greyed.
    const blocked = section.locator('[data-grant-id="r-s3"] [data-verb="revoke"]');
    await expect(blocked).toBeDisabled();

    await page.locator('[data-grant-id="g-web"] [data-verb="extend"]').click();
    await expect(page.locator(sel.preset)).toHaveText(["+15m", "+30m", "+1h", "Indefinite"]);
    await shot(page, "grants extend presets");
    await page.locator(`${sel.preset}[data-minutes="60"]`).click();
    await expect.poll(() => posted).toContainEqual({ url: expect.stringMatching(/\/grants\/k8s\/g-web\/extend$/), body: { minutes: 60 } });

    await expect(page.locator(sel.inactive)).toHaveCount(0);
    await page.locator(sel.inactiveToggle).click();
    await expect(page.locator(sel.inactive).locator(sel.grant)).toHaveCount(2);
    await expect(page.locator(sel.inactive)).toContainText("Revoked by alice@example.com");
    await shot(page, "grants inactive light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(500);
    await shot(page, "grants inactive dark");
    await page.emulateMedia({ colorScheme: "light" });

    await page.locator('[data-grant-id="g-api"] [data-verb="revive"]').click();
    await page.locator(`${sel.preset}[data-minutes="30"]`).click();
    await expect.poll(() => posted).toContainEqual({ url: expect.stringMatching(/\/grants\/k8s\/g-api\/revive$/), body: { minutes: 30 } });

    await page.locator('[data-grant-id="g-web"] [data-verb="extend"]').click();
    await page.locator(`${sel.preset}[data-verb="pin"]`).click();
    await expect.poll(() => posted).toContainEqual({ url: expect.stringMatching(/\/grants\/k8s\/g-web\/pin$/), body: {} });
  });
});
