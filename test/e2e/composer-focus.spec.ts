/**
 * E2E (fast): the composer takes focus when a run starts only while the chat's own document
 * has focus. A chat framed beside another pane must leave the user's typing in that pane alone.
 */

import { test, expect, sel } from "./fixtures.js";

const HOST = "/__composer-focus-host";

test.describe("composer focus", () => {
  test("a framed chat leaves focus in a sibling input when a run starts", async ({ page }) => {
    await page.route(`**${HOST}`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><input id="note" aria-label="Note">
          <iframe src="/" title="chat" style="width:1000px;height:700px"></iframe>`,
      }),
    );
    await page.goto(HOST);
    const note = page.getByLabel("Note");
    await note.click();
    const frame = page.frameLocator('iframe[title="chat"]');
    const input = frame.locator(sel.composerInput).first();
    await expect(input).toBeVisible({ timeout: 20_000 });
    // Mounting the framed chat leaves focus in the note.
    await expect(note).toBeFocused();

    await input.fill("!sleep 2");
    await note.click();
    await page.keyboard.type("half a ");
    // A synthetic click sends without moving focus into the frame.
    await frame.getByRole("button", { name: /send/i }).first().dispatchEvent("click");
    await expect(frame.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.type("word");
    await expect(note).toBeFocused();
    await expect(note).toHaveValue("half a word");
    await expect(frame.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: 45_000 });
    await expect(note).toBeFocused();
  });

  test("a focused chat moves focus to the composer when a run starts", async ({ chat, page }) => {
    await chat.open();
    await chat.input().fill("!sleep 2");
    const send = page.getByRole("button", { name: /send/i }).first();
    await send.focus();
    await send.press("Enter");
    await expect(chat.input()).toBeFocused({ timeout: 30_000 });
    await chat.waitForIdle();
  });
});
