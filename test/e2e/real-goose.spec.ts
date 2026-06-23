/**
 * Tier 3 E2E — ONE scenario with the REAL `goose acp` binary + a real sandbox.
 *
 * Proves the actual agent integrates end to end (ACP -> bridge -> AG-UI -> UI,
 * and ACP terminal/fs -> agent-sandbox exec). Non-deterministic + needs a model
 * provider (Bedrock) and a cluster, so it is gated and asserted loosely.
 *
 * Run against a stack started in REAL mode (not fake):
 *   RUN_REAL_GOOSE=1  (+ GOOSE_PROVIDER/GOOSE_MODEL/AWS_* and a cluster)
 */

import { test, expect } from "./fixtures.js";

const run = process.env.RUN_REAL_GOOSE === "1";

test.describe(run ? "real goose" : "real goose (skipped)", () => {
  test.skip(!run, "set RUN_REAL_GOOSE=1 + Bedrock creds + a cluster");

  test("real goose responds to a prompt", async ({ chat }) => {
    await chat.open();
    await chat.send("Create a file hello.txt containing the word kubenix, then show its contents.");

    // Loose: a tool call runs and the final answer mentions the word.
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 120_000 });
    await expect(chat.assistantMessages().last()).toContainText(/kubenix/i, { timeout: 120_000 });
  });
});
