// E2E (fast): math renders only with math's manifest row.

import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures.js";

const MATH = { markdownSyntax: { math: { contrib: "math", entry: "math/ui/MathSyntax.tsx" } } };

async function serveManifest(page: Page, rows: object) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) }),
  );
}

// Inline and display math, a price, and broken TeX.
const CMD =
  `!printf '%s\\n' 'area $$\\pi r^2$$ and \\(e^{i\\pi}\\)' '' '$$' '\\sum_i x_i' '$$' '' ` +
  `'costs $5 and $10' '' 'bad \\(\\frac{\\)'`;

test.describe("math in chat", () => {
  test.setTimeout(120_000);

  test("TeX renders with KaTeX while single $ and bad TeX stay text", async ({ chat, page }) => {
    await serveManifest(page, MATH);
    await chat.open();
    await chat.sendTurn(CMD, 90_000);

    const reply = chat.assistantMessages().last();
    // Two inline roots and one display root.
    await expect(reply.locator(".math-inline .katex")).toHaveCount(2, { timeout: 30_000 });
    await expect(reply.locator(".math-display .katex-display")).toHaveCount(1);
    await expect(reply).toContainText("costs $5 and $10");
    // \frac{ does not parse, so its source shows instead.
    await expect(reply.locator("code[data-tex-source]")).toHaveText("\\frac{");

    // User messages render math too; other text stays as typed.
    const mine = page.locator('[data-role="user"]').last();
    await expect(mine.locator(".katex").first()).toBeVisible();
    await expect(mine).toContainText("!printf '%s\\n'");
  });

  test("without the contrib, the TeX is plain text", async ({ chat, page }) => {
    await serveManifest(page, {});
    await chat.open();
    await chat.sendTurn(CMD, 90_000);

    const reply = chat.assistantMessages().last();
    await expect(reply).toContainText("area $$\\pi r^2$$");
    await expect(page.locator(".katex")).toHaveCount(0);
  });
});
