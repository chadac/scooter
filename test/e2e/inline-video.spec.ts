/**
 * E2E for show_video: a tool result carrying a video ref renders a playable <video> in the
 * thread. The fake agent's `~video` directive emits the result; this spec serves the clip,
 * honouring Range, since the fake stack has no sandbox to store one from.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { test, expect } from "./fixtures.js";

const CLIP = readFileSync(fileURLToPath(new URL("./support/demo.webm", import.meta.url)));

test.describe("inline video", () => {
  test("a show_video result plays inline in the tool card", async ({ chat, page }) => {
    await page.route("**/assets/fake-demo.webm", (route) =>
      route.fulfill({ status: 200, contentType: "video/webm", body: CLIP, headers: { "Accept-Ranges": "bytes" } }),
    );
    await chat.open();
    await chat.sendTurn("~video");

    const video = page.locator('[data-slot="media-video"]').last();
    await expect(video).toBeVisible({ timeout: 20_000 });
    await expect(video).toHaveAttribute("controls", "");
    // HAVE_METADATA or better: the browser fetched and parsed the clip.
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    expect(await video.evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(1);
    // The result's status text sits in the folded body: in the DOM (find-in-page reaches it)
    // but hidden until the card is opened.
    const status = page.getByText("Showing /workspace/demo.webm");
    await expect(status).toHaveCount(1);
    await expect(status).toBeHidden();
    await page.locator('[data-slot="tool-fallback-trigger"]').last().click();
    await expect(status).toBeVisible();
  });
});
