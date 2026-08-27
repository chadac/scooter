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
import { fastOnly } from "./target.js";

const run = process.env.RUN_REAL_GOOSE === "1";

// Env-gated everywhere: this spec exists to prove the REAL `goose acp` binary, which needs a
// model provider (Bedrock creds). It is NOT in the full-target allowlist (test/e2e/full-specs.json)
// and is gated out of the full project besides: CI's k3d cluster runs the fake agent
// (GOOSE_BIN=fake, modules/testing.nix) with no provider, so the real binary can never be present
// there — running this spec against it would "pass" by testing the fake agent under a "real goose"
// name. The only honest run is RUN_REAL_GOOSE=1 against a stack started in real mode.
const maybe = run
  ? test.describe
  : fastOnly(
      "needs the real goose binary + a model provider — CI's full-target cluster runs GOOSE_BIN=fake; run manually with RUN_REAL_GOOSE=1 + Bedrock creds",
    );

maybe(run ? "real goose" : "real goose (skipped)", () => {
  test.skip(!run, "set RUN_REAL_GOOSE=1 + Bedrock creds + a cluster");

  test("real goose responds to a prompt", async ({ chat }) => {
    await chat.open();
    await chat.send("Create a file hello.txt containing the word kubenix, then show its contents.");

    // Loose: a tool call runs and the final answer mentions the word.
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 120_000 });
    await expect(chat.assistantMessages().last()).toContainText(/kubenix/i, { timeout: 120_000 });
  });

  test("real goose tool calls survive a page refresh", async ({ chat, page }) => {
    // The fake agent emits a single, tidy tool call; REAL goose emits richer
    // shapes (tool calls with no parent assistant text, multiple calls per turn).
    // This is where "tool calls vanish after refresh" would actually reproduce —
    // the fake-stack refresh test can't exercise it. Drive a real tool-using
    // turn, reload, and assert the tool call replays from the persisted log.
    await chat.open();
    await chat.send("Run `echo kubenix-refresh-marker` in the shell and report the output.");
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 120_000 });
    await expect(chat.assistantMessages().last()).toContainText(/kubenix-refresh-marker/i, { timeout: 120_000 });

    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // The tool call must rebuild from events.integrity replay, not the live stream.
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 60_000 });
  });
});
