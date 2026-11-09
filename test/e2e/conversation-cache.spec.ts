/**
 * Switching back to a conversation paints its thread from the browser cache before the
 * server answers, shows the syncing indicator until the resumed stream reaches `synced`,
 * and then carries on live.
 */

import { test, expect } from "./fixtures.js";

const item = '[data-testid="session-item"]';
const newButton = '[data-testid="new-session"]';
const syncing = '[data-testid="syncing-indicator"]';

test.describe("conversation cache", () => {
  test.setTimeout(180_000);

  test("a revisited conversation paints from the cache while the stream catches up", async ({ chat, page }) => {
    await chat.open();
    await chat.send("alpha-cached");
    await chat.waitForReply(/dummy agent/i);
    await page.locator(newButton).click();
    await chat.send("bravo-cached");
    await chat.waitForReply(/dummy agent/i);
    await expect(page.locator(item).filter({ hasText: /alpha-cached/i })).toHaveCount(1, { timeout: 30_000 });

    // Hold the stream so only the cache can paint A.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const resumed: string[] = [];
    await page.route("**/events.integrity*", async (route) => {
      resumed.push(route.request().url());
      await held;
      await route.continue();
    });

    await page.locator(item).filter({ hasText: /alpha-cached/i }).first().click();
    await expect(chat.userMessages().filter({ hasText: /alpha-cached/i })).toHaveCount(1, { timeout: 5_000 });
    await expect(chat.userMessages().filter({ hasText: /bravo-/i })).toHaveCount(0);
    await expect(page.locator(syncing).getByText("Syncing…")).toBeVisible();

    release();
    await expect(page.locator(syncing)).toHaveCount(0, { timeout: 30_000 });
    expect(resumed.some((u) => /afterSeq=\d+&checksum=[0-9a-f]{64}/.test(u))).toBe(true);
    await page.unroute("**/events.integrity*");

    // Still live after the resume.
    await chat.send("alpha-after-resume");
    await chat.waitForReply(/dummy agent/i);
    await expect(chat.userMessages().filter({ hasText: /alpha-/i })).toHaveCount(2);
  });
});
