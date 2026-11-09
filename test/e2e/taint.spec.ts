/**
 * e2e for a private conversation's taint: the owner sees who else wrote in it from the lock
 * button's privacy panel, and clears exactly that.
 */

import { test, expect, seedConversation } from "./fixtures.js";

test.describe("conversation taint", () => {
  test("the owner sees why a private conversation is tainted, and clears it", async ({ browser, request, baseURL }) => {
    test.setTimeout(120_000);
    const base = (baseURL ?? "http://localhost:5173").replace(/\/$/, "");
    const id = await seedConversation(request, base, "alice", "Fix the release workflow");
    // Bob steers it while it is shared, then alice makes it private.
    const steer = await request.post(`${base}/conversations/${id}/messages`, {
      data: { text: "also bump the version" },
      headers: { "x-auth-user": "bob" },
    });
    expect(steer.ok()).toBeTruthy();
    const flip = await request.patch(`${base}/conversations/${id}/visibility`, {
      data: { visibility: "private" },
      headers: { "x-auth-user": "alice" },
    });
    expect(flip.ok()).toBeTruthy();

    const context = await browser.newContext({ extraHTTPHeaders: { "x-auth-user": "alice" } });
    const page = await context.newPage();
    try {
      await page.goto(`/?thread=${id}`);
      await page.locator('[data-testid="session-visibility"]').click();
      const panel = page.locator('[data-testid="privacy-panel"]');
      await expect(panel.locator('[data-testid="taint-reasons"]')).toContainText("user bob");
      await panel.screenshot({ path: test.info().outputPath("taint-reasons.png") });

      let confirm = "";
      page.once("dialog", (d) => {
        confirm = d.message();
        void d.accept();
      });
      await panel.locator('[data-testid="taint-clear"]').click();
      await expect(panel.locator('[data-testid="taint-clean"]')).toBeVisible();
      expect(confirm).toContain("• user bob");
      await panel.screenshot({ path: test.info().outputPath("taint-clean.png") });

      const after = await request.get(`${base}/conversations/${id}/taint`, { headers: { "x-auth-user": "alice" } });
      expect((await after.json()).authors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
