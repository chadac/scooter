/**
 * E2E (fast+full): an agent-posted ```scooter-embed block renders as a sandboxed iframe.
 * The `!<cmd>` harness pipes a shell command's stdout into the assistant reply, so the
 * fence is emitted from the command's output; the command text must stay backtick-free
 * because the fake agent echoes it inside an inline-code span, so the backticks come from
 * octal (\140) via a command substitution. Only assistant messages run MarkdownText,
 * which turns the fence into the iframe through the shares contrib, whose manifest rows a
 * route serves, since the fast stack's vite dev server has no /contrib/manifest.json.
 * The full publish -> embed -> serve loop needs the
 * broker's `shares` subsystem enabled in-cluster (see the fullOnly block).
 */

import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures.js";
import { fullOnly } from "./target.js";

const UUID = "7f3c2a1e-1b2c-4d5e-8f90-abcdef012345";

// A shell fragment that prints three backticks via octal escape, keeping literal backticks
// out of the command text.
const BT = `"$(printf '\\140\\140\\140')"`;

/** A `!printf` whose stdout is a scooter-embed fence (one line per arg). */
function embedCmd(share: string, ...extra: string[]): string {
  const args = [`${BT}scooter-embed`, `'share: ${share}'`, ...extra.map((e) => `'${e}'`), BT];
  return `!printf '%s\\n' ${args.join(" ")}`;
}

const SHARES = {
  panels: { shares: { contrib: "shares", label: "Shares", order: 100, entry: "shares/ui/Panel.tsx" } },
  markdownFences: { "scooter-embed": { contrib: "shares", entry: "shares/ui/Embed.tsx" } },
};

/** Serve a manifest whose shares rows are `rows`, or none. */
async function serveManifest(page: Page, rows: { panels?: unknown; markdownFences?: unknown } = SHARES) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) }),
  );
}

test.describe("share embed markdown block", () => {
  test.setTimeout(120_000);
  test.beforeEach(({ page }) => serveManifest(page));

  test("an assistant scooter-embed block renders a sandboxed iframe", async ({ chat, page }) => {
    await chat.open();
    // sendTurn waits until this turn's assistant reply has landed.
    await chat.sendTurn(embedCmd(UUID, "width: 400", "center: true"), 90_000);

    // The fence is replaced by the shares contrib's Embed, so assert the iframe, not the raw text.
    const frame = page.locator('[data-testid="share-embed"] iframe');
    await expect(frame).toBeVisible({ timeout: 30_000 });

    // src is rebuilt from the validated UUID as a /s/<uuid>/ path, never external.
    await expect(frame).toHaveAttribute("src", new RegExp(`/s/${UUID}/$`));

    // Security invariants: sandboxed, and not same-origin.
    const sandbox = (await frame.getAttribute("sandbox")) ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  test("a non-share reference renders an error, not an iframe", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn(embedCmd("https://evil.example.com/"), 90_000);
    await expect(page.locator('[data-testid="share-embed-error"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="share-embed"] iframe')).toHaveCount(0);
  });

  test("the Shares section renders the contrib panel's empty state", async ({ chat, page }) => {
    await chat.open();
    await expect(page.getByTestId("right-panel-section-contrib-shares")).toBeVisible();
    await expect(page.getByTestId("shares-empty")).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("share embed without the shares contrib", () => {
  test.setTimeout(120_000);
  test.beforeEach(({ page }) => serveManifest(page, {}));

  test("the fence renders as code and there is no Shares section", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn(embedCmd(UUID), 90_000);
    await expect(chat.assistantMessages().last()).toContainText(`share: ${UUID}`);
    await expect(page.locator('[data-testid="share-embed"]')).toHaveCount(0);
    await expect(page.getByTestId("right-panel-section-contrib-shares")).toHaveCount(0);
  });
});

// The real publish -> embed -> serve loop, which runs only on the full target and
// self-skips unless the broker has `shares` enabled.
fullOnly("needs the broker shares subsystem enabled in-cluster")("share embed full flow", () => {
  test.setTimeout(240_000);

  test("agent publishes a static file, embeds it, and the iframe serves it", async ({ chat, page }) => {
    await chat.open();

    // Publish a one-file share through the real broker via the `!` exec harness.
    const html = "<h1 id=embed-marker>hello from a published share</h1>";
    const b64 = Buffer.from(html).toString("base64");
    await chat.sendTurn(
      `!agent-broker shares -X POST -H 'Content-Type: application/json' ` +
        `-d '{"files":{"index.html":{"content_type":"text/html","b64":"${b64}"}}}'`,
      120_000,
    );

    // If shares is not enabled the POST 404s, so skip rather than fail.
    const reply = chat.assistantMessages().last();
    const m = (await reply.innerText()).match(/"uuid"\s*:\s*"([0-9a-f-]{36})"/i);
    test.skip(!m, "broker shares not enabled in this deployment");
    const uuid = m![1];

    // Embed it, then assert the iframe renders and serves the published content.
    await chat.sendTurn(embedCmd(uuid), 90_000);
    const frame = page.locator('[data-testid="share-embed"] iframe');
    await expect(frame).toBeVisible({ timeout: 30_000 });
    await expect(frame).toHaveAttribute("src", new RegExp(`/s/${uuid}/$`));
    await expect(frame.contentFrame().locator("#embed-marker")).toContainText(/published share/i, {
      timeout: 90_000,
    });
  });
});
