/**
 * Tier 3 E2E — a composer image attachment reaches the agent PROCESS.
 *
 * The regression this guards (PR #448): @assistant-ui/core's composer sends the
 * outgoing message as `content: [{type:"text"}]` (text only) and puts each attached
 * image in a SEPARATE `message.attachments[]` — the image part lives in
 * `attachment.content`, never in `message.content`. The old `onNew` read only
 * `message.content`, so every upload was silently dropped BEFORE the /agui POST and
 * nothing ever reached goose. A UI-only unit test can't catch this (it depends on the
 * real composer wiring); only driving the actual composer does.
 *
 * Two independent proofs, end-to-end through the real (fake) stack:
 *   1. WIRE: the outgoing POST /agui body carries an image content part (the client
 *      actually serialized + sent it — the exact boundary the bug broke).
 *   2. PROCESS: the fake agent's `~images` directive reports images=1 — proof the
 *      image survived the whole pipe (composer -> /agui -> normalizeContent ->
 *      AssetStore -> bridge readAsset -> ACP image block -> agent process).
 */

import { test, expect } from "./fixtures.js";

// A minimal valid 1x1 transparent PNG. Tiny (well under the 5MB cap) and an allowed
// MIME (image/png), so it passes the client downscale + the agent-host AssetStore.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test.describe("image upload", () => {
  test("an attached image reaches the agent process (not dropped in the composer)", async ({
    chat,
    page,
  }) => {
    await chat.open();

    // Capture the outgoing POST /agui body (proof #1 — the wire). Same-origin in e2e
    // (VITE_AGENT_HOST_URL empty), so the UI POSTs /agui through the vite proxy.
    let aguiBody: string | null = null;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith("/agui")) {
        aguiBody = req.postData();
      }
    });

    // Attach the image via the real composer. ComposerPrimitive.AddAttachment spawns a
    // transient <input type=file> and calls .click() -> a native file chooser, which
    // Playwright drives through the filechooser event.
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByLabel("Add Attachment").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "shot.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_1x1_BASE64, "base64"),
    });

    // The staged attachment renders a preview thumbnail in the composer.
    await expect(page.getByRole("img", { name: /attachment preview/i }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Send with the ~images directive: the fake agent replies with the count of IMAGE
    // content blocks it received in the prompt. Fill + click Send explicitly (a staged
    // attachment + Enter is less reliable than the button).
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.click();
    await input.fill("~images");
    await page.getByRole("button", { name: /send message/i }).click();

    // The send must land in the VIEWED thread (the user message renders here).
    await expect(chat.userMessages().last()).toContainText("~images", { timeout: 20_000 });

    // Proof #2 — reached the process: the image block made it all the way to the agent.
    await expect(chat.assistantMessages().last()).toContainText(/images=1/, {
      timeout: 45_000,
    });

    // Proof #1 — the wire: the POST /agui body carried an image part. (Before the fix
    // this was absent — content was text-only and attachments were never read.)
    console.log("[image-upload] aguiBody:", aguiBody?.slice(0, 300));
    expect(aguiBody, "a POST /agui should have been observed").not.toBeNull();
    const parsed = JSON.parse(aguiBody!) as {
      messages?: Array<{ content?: unknown }>;
    };
    const parts = parsed.messages?.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : [],
    );
    expect(parts?.some((p) => p?.type === "image")).toBe(true);
  });
});
