/** E2E: each user's default retention policy for unfiled conversations. */

import { type Browser, type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const uniqueUser = () => `e2e-retention-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function pageAs(browser: Browser, user: string): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-auth-user": user } });
  return context.newPage();
}

async function openConversations(page: Page) {
  await page.goto("/settings/conversations");
  await expect(page.getByTestId("retention-section").getByRole("radiogroup")).toBeVisible({ timeout: 20_000 });
}

const choice = (page: Page, name: string) => page.getByTestId("retention-section").getByRole("radio", { name });

test.describe("settings — conversation retention policy", () => {
  test.setTimeout(90_000);

  test("a preset, a custom value and the deployment default are saved per account", async ({ browser }) => {
    const user = uniqueUser();
    const page = await pageAs(browser, user);
    await openConversations(page);
    // The fake stack keeps unfiled conversations forever.
    await expect(choice(page, "Deployment default (never)")).toHaveAttribute("aria-checked", "true");

    await choice(page, "1 week").click();
    await expect(choice(page, "1 week")).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await (await page.request.get("/whoami")).json()).retention).toEqual({ defaultLifetimeHours: 168 });

    const section = page.getByTestId("retention-section");
    await section.getByRole("button", { name: "Custom…" }).click();
    const form = page.getByTestId("custom-lifetime");
    await form.getByRole("textbox").fill("3");
    await form.getByLabel("Unit").selectOption("days");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(choice(page, "3 days")).toHaveAttribute("aria-checked", "true");

    // Another browser of the same account sees it; another user doesn't.
    const again = await pageAs(browser, user);
    await openConversations(again);
    await expect(choice(again, "3 days")).toHaveAttribute("aria-checked", "true");
    const other = await pageAs(browser, uniqueUser());
    await openConversations(other);
    await expect(choice(other, "Deployment default (never)")).toHaveAttribute("aria-checked", "true");

    await choice(page, "Deployment default (never)").click();
    await expect.poll(async () => (await (await page.request.get("/user-retention")).json()).lifetimeHours).toBeUndefined();
    for (const p of [page, again, other]) await p.context().close();
  });
});
