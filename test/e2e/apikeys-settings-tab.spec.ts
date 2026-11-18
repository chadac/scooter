/**
 * Tier 3 E2E for the apikeys contrib's settings tab: a new key is shown once, then
 * listed without its secret, and revoked. The fast stack runs no broker, so the
 * /apikeys/user/* routes are an in-memory stand-in at the browser.
 */

import { type Page, type Route } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const TAB = { contrib: "apikeys", label: "API keys", order: 60, entry: "apikeys/ui/SettingsTab.tsx" };
const SECRET = "sct_abcdefghijkl_" + "S".repeat(43);

async function serveTab(page: Page) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sources: {}, toolCards: {}, toolTitles: {}, linkProviders: [], approvals: {},
        settingsTabs: { apikeys: TAB },
      }),
    }),
  );
}

interface Key { key_id: string; name: string; scopes: string[]; created_at: string; expires_at: string; last_used_at: string | null; last_used_ip: string | null }

/** The broker's /apikeys/user/* routes, held in memory. */
async function fakeBroker(page: Page) {
  const keys: Key[] = [];
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/contrib-api/apikeys/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/contrib-api\/apikeys\//, "");
    if (path === "keys" && req.method() === "GET") return json(route, { keys, limit: 10, max_days: 365 });
    if (path === "keys" && req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}");
      const k: Key = {
        key_id: "abcdefghijkl", name: body.name, scopes: body.scopes,
        created_at: "2026-11-18T23:00:00+00:00", expires_at: "2027-02-16T23:00:00+00:00",
        last_used_at: null, last_used_ip: null,
      };
      keys.unshift(k);
      return json(route, { ...k, key: SECRET });
    }
    const m = path.match(/^keys\/(.+)$/);
    const i = m ? keys.findIndex((k) => k.key_id === m[1]) : -1;
    if (req.method() !== "DELETE" || i < 0) return json(route, { detail: "no such key" }, 404);
    keys.splice(i, 1);
    return json(route, { revoked: m![1] });
  });
}

test.describe("API keys settings tab", () => {
  test("shows its error card while the broker routes are unavailable", async ({ page }) => {
    await serveTab(page);
    await page.route("**/contrib-api/apikeys/**", (route) =>
      route.fulfill({ status: 501, contentType: "text/plain", body: "not implemented" }),
    );
    await page.goto("/settings/apikeys");
    await expect(page.getByText("Couldn't load your API keys")).toBeVisible({ timeout: 20_000 });
  });

  test("a key is shown once, listed without its secret, and revoked", async ({ page }) => {
    await serveTab(page);
    await fakeBroker(page);
    await page.goto("/settings/apikeys");
    await expect(page.getByText("No API keys yet")).toBeVisible({ timeout: 20_000 });

    await page.getByLabel("Key name").fill("laptop");
    await page.getByLabel("Read-only").check();
    await page.getByRole("button", { name: "Create key" }).click();
    await expect(page.getByLabel("New API key")).toHaveValue(SECRET);
    const list = page.locator('[data-testid="apikeys-keys"]');
    await expect(list).toContainText("laptop");
    await expect(list).toContainText("Read-only");
    await expect(list).not.toContainText(SECRET);

    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByLabel("New API key")).toHaveCount(0);

    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("No API keys yet")).toBeVisible();
  });
});
