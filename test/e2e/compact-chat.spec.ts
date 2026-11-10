/**
 * Tier 3 E2E for compact density on the conversation subpage, `/chat/<id>?density=compact`
 * (services/ui/src/density.ts): consecutive tool-call messages fold to one line that expands
 * them all, the header toggle overrides the host's choice and remembers it, and the main
 * app never goes compact.
 */

import { test, expect, seedConversation } from "./fixtures.js";
import { fastOnly } from "./target.js";

const root = '[data-testid="chat-page"]';
const toggle = '[data-testid="chat-page-density"]';
const line = '[data-slot="tool-group-compact-trigger"]';
const expanded = '[data-slot="tool-group-compact-content"]';

// fastOnly: the fake agent's ~tools directive scripts the tool runs.
fastOnly("drives the fake agent's ~tools directive")("compact chat density", () => {
  test.beforeEach(() => test.setTimeout(120_000));

  test("folds each run of tool calls to one line, and the toggle undoes it", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    const id = await seedConversation(request, base, null, "Compact density");

    await page.goto(`/chat/${id}?density=compact`);
    await expect(page.locator(root)).toHaveAttribute("data-density", "compact");
    await expect(page.locator(toggle)).toHaveAttribute("aria-pressed", "true");
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    await chat.sendTurn("~tools");
    await expect(page.getByText("Want me to add a cache")).toBeVisible({ timeout: 30_000 });

    // Three tool messages, then prose, then two more: two lines, not five.
    const lines = page.locator(line);
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText("3 tool calls");
    await expect(lines.nth(0)).toContainText("grep, read_file, bash");
    await expect(lines.nth(1)).toContainText("2 tool calls");
    await expect(lines.nth(1)).toContainText("edit, bash");
    await expect(page.locator(expanded)).toHaveCount(0);

    // Expanding the first line shows all three of its messages' calls, and only those.
    await lines.nth(0).click();
    await expect(lines.nth(0)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(expanded)).toHaveCount(3);
    await lines.nth(0).click();
    await expect(page.locator(expanded)).toHaveCount(0);

    // The toggle overrides the host's compact, and the choice outlives a reload.
    await page.locator(toggle).click();
    await expect(page.locator(root)).toHaveAttribute("data-density", "comfortable");
    await expect(page.locator(line)).toHaveCount(0);
    await page.reload();
    await expect(page.locator(root)).toHaveAttribute("data-density", "comfortable");

    // A host that never asked for compact isn't affected by the choice either way.
    await page.locator(toggle).click();
    await page.goto(`/chat/${id}`);
    await expect(page.locator(root)).toHaveAttribute("data-density", "comfortable");
  });

  test("the main app's thread is never compact", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    const id = await seedConversation(request, base, null, "Compact main app");

    await page.goto(`/chat/${id}?density=compact`);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await chat.sendTurn("~tools");
    await expect(page.locator(line)).toHaveCount(2, { timeout: 30_000 });

    await page.goto(`/?thread=${id}`);
    await expect(page.getByText("Want me to add a cache")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(line)).toHaveCount(0);
  });
});
