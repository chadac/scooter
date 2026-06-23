/**
 * Tier 3 E2E (Playwright) — the core happy path through the UI.
 *
 * provision -> prompt -> AG-UI events render live; multi-turn; tool-permission
 * approval. Runs against a deployed agent-host with the FAKE ACP agent (scripted
 * + deterministic). RED.
 */

import { test, expect } from "@playwright/test";

test.describe("conversation happy path", () => {
  test("new conversation: prompt streams assistant message + tool call", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /new conversation/i }).click();

    await page.getByRole("textbox", { name: /message/i }).fill("List the files");
    await page.getByRole("button", { name: /send/i }).click();

    // AG-UI TextMessage* renders incrementally.
    await expect(page.getByTestId("assistant-message").last()).toContainText(/.+/, { timeout: 30_000 });
    // AG-UI ToolCall* renders as a tool-call card with a result.
    await expect(page.getByTestId("tool-call").last()).toBeVisible();
    await expect(page.getByTestId("tool-call-result").last()).toBeVisible();
  });

  test("multi-turn: a follow-up prompt continues the same thread", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /new conversation/i }).click();
    await page.getByRole("textbox", { name: /message/i }).fill("first");
    await page.getByRole("button", { name: /send/i }).click();
    await expect(page.getByTestId("assistant-message").last()).toBeVisible({ timeout: 30_000 });

    await page.getByRole("textbox", { name: /message/i }).fill("second");
    await page.getByRole("button", { name: /send/i }).click();

    await expect(page.getByTestId("user-message")).toHaveCount(2);
  });

  test("tool-permission approval gates a tool call", async ({ page }) => {
    await page.goto("/?script=permission"); // fake agent scripted to request permission
    await page.getByRole("button", { name: /new conversation/i }).click();
    await page.getByRole("textbox", { name: /message/i }).fill("do something privileged");
    await page.getByRole("button", { name: /send/i }).click();

    const approve = page.getByRole("button", { name: /approve/i });
    await expect(approve).toBeVisible({ timeout: 30_000 });
    await approve.click();
    await expect(page.getByTestId("tool-call-result").last()).toBeVisible();
  });
});
