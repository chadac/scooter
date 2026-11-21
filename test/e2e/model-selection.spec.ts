/**
 * Tier 3 E2E for per-conversation model selection through the real UI. The fake stack
 * runs the prebuilt services/agent-host/dist, so an agent-host change needs
 * `npm -w services/agent-host run build` before these tests see it. The stack runs with
 * GOOSE_MODEL=model-default and AGENT_AVAILABLE_MODELS=model-default,model-fast,model-smart,
 * and the fake agent echoes its launch GOOSE_MODEL via the "~model" directive, so picking
 * a model and sending "~model" proves the choice reached the agent process end to end.
 */

import { test, expect } from "./fixtures.js";

test.describe("model selection", () => {
  test("the picker offers the configured models with the default marked", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();
    // One option per (model, provider) pair: model-default under both groups.
    await expect(picker.locator("option")).toHaveCount(4);
    // Exactly one option is (default), even when the model is offered by both.
    await expect(picker.locator("option", { hasText: "(default)" })).toHaveCount(1);
  });

  test("default model is used when nothing is picked", async ({ chat }) => {
    await chat.open();
    await chat.send("~model");
    await expect(chat.assistantMessages().last()).toContainText(/model=model-default/, {
      timeout: 45_000,
    });
  });

  test("picking a non-default model sends it to the agent", async ({ chat, page }) => {
    await chat.open();
    await page.getByTestId("model-picker").selectOption("model-smart");
    await chat.send("~model");

    // The fake agent reports the GOOSE_MODEL it was launched with.
    await expect(chat.assistantMessages().last()).toContainText(/model=model-smart/, {
      timeout: 45_000,
    });
  });

  test("switching the model mid-conversation takes effect on the next prompt", async ({ chat, page }) => {
    await chat.open();
    await page.getByTestId("model-picker").selectOption("model-fast");
    await chat.send("~model");
    await expect(chat.assistantMessages().last()).toContainText(/model=model-fast/, { timeout: 45_000 });

    // Switch mid-conversation; the next prompt rebuilds goose with the new model.
    await page.getByTestId("model-picker").selectOption("model-smart");
    await chat.send("~model");
    await expect(chat.assistantMessages().last()).toContainText(/model=model-smart/, { timeout: 45_000 });
  });

  test("a mid-conversation switch is saved without sending a message", async ({ chat, page }) => {
    await chat.open();
    await chat.send("~model");
    await expect(chat.assistantMessages().last()).toContainText(/model=model-default/, { timeout: 45_000 });

    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/conversations\/[^/]+\/model$/.test(r.url()));
    await page.getByTestId("model-picker").selectOption("model-smart");
    expect((await saved).ok()).toBe(true);
    await expect(page.getByTestId("model-switching")).toHaveCount(0);
    await expect(chat.userMessages()).toHaveCount(1);

    // The server holds the pick, so it survives a reload.
    await page.reload();
    await expect(page.getByTestId("model-picker")).toHaveValue(/model-smart$/);
    await chat.send("~model");
    await expect(chat.assistantMessages().last()).toContainText(/model=model-smart/, { timeout: 45_000 });
  });
});

// --- Provider grouping ----------------------------------------------------------
//
// The grouped branch only renders when the catalog tags models with providers.

test.describe("model selection — provider grouping", () => {
  test("REPRO 1: each option's value carries its PROVIDER, not just the model id", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();

    // The grouped branch must actually render, asserted on the DOM because getByRole flattens optgroup.
    await expect(picker.locator("optgroup")).toHaveCount(2);

    const values = await picker.locator("option").evaluateAll((os) =>
      os.map((o) => (o as HTMLOptionElement).value),
    );
    // model-default is offered by both providers, so it appears twice and the two options must be distinguishable.
    const forDefault = values.filter((v) => v.endsWith("model-default"));
    expect(forDefault.length).toBe(2);
    expect(new Set(forDefault).size).toBe(2);
    expect(values).toContain("byoc:model-default");
    expect(values).toContain("claude-code:model-default");
  });

  test("REPRO 2: exactly ONE option is marked (default)", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();

    // The default model renders under each group; only one copy carries the label.
    const labelled = await picker.locator("option").evaluateAll((os) =>
      os.filter((o) => o.textContent?.includes("(default)")).map((o) => o.textContent ?? ""),
    );
    expect(labelled.length).toBe(1);
    expect(labelled[0]).toContain("model-default");
  });

  test("REPRO 3: picking a provider-only model routes to THAT provider", async ({ chat, page }) => {
    await chat.open();
    // model-fast is claude-code only, and picking it must still reach the agent.
    await page.getByTestId("model-picker").selectOption("claude-code:model-fast");
    await chat.send("~model");
    await expect(chat.assistantMessages().last()).toContainText(/model=model-fast/, {
      timeout: 45_000,
    });
  });
});
