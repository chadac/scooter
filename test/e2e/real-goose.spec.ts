/**
 * Tier 3 E2E — ONE scenario with the real `goose acp` binary.
 *
 * Proves the actual agent integrates end to end (ACP -> bridge -> AG-UI -> UI,
 * and ACP terminal/fs -> agent-sandbox exec). Non-deterministic + needs a model
 * key, so gated and asserted loosely. RED.
 *
 *   RUN_REAL_GOOSE=1  (+ model provider creds for goose)
 */

import { test, expect } from "@playwright/test";

const run = process.env.RUN_REAL_GOOSE === "1";

test.describe(run ? "real goose" : "real goose (skipped)", () => {
  test.skip(!run, "set RUN_REAL_GOOSE=1 and provide goose model credentials");

  test("real goose completes a simple file task in the sandbox", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /new conversation/i }).click();
    await page
      .getByRole("textbox", { name: /message/i })
      .fill("Create a file hello.txt containing the word kubenix, then show its contents.");
    await page.getByRole("button", { name: /send/i }).click();

    // Loose assertions: a tool call ran, and the final answer mentions the word.
    await expect(page.getByTestId("tool-call").last()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("assistant-message").last()).toContainText(/kubenix/i, { timeout: 120_000 });
  });
});
