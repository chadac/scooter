/**
 * Tier 3 E2E for the mcpservers contrib's settings tab: it renders from the manifest,
 * shows its error card while the broker routes are unreachable, and adds, toggles and
 * removes a server through /contrib-api. The fast stack runs no broker, so those routes
 * are an in-memory stand-in at the browser.
 */

import { type Page, type Route } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const TAB = { contrib: "mcpservers", label: "MCP servers", order: 43, entry: "mcpservers/ui/SettingsTab.tsx" };

async function serveTab(page: Page) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sources: {}, toolCards: {}, toolTitles: {}, linkProviders: [], approvals: {},
        settingsTabs: { mcpservers: TAB },
      }),
    }),
  );
}

interface Server { id: string; name: string; kind: string; spec: string; args: string[]; enabled: boolean }

const CATALOG = {
  servers: [
    { name: "fetch", kind: "pypi", spec: "mcp-server-fetch", description: "Fetch a URL and read it as markdown" },
    { name: "github", kind: "nixpkgs", spec: "github-mcp-server", args: ["stdio"], needs_api_key: true, description: "GitHub repos, issues and pull requests" },
  ],
};

const REGISTRY_HIT = {
  registry_name: "io.github.microsoft/playwright-mcp", kind: "npm", spec: "@playwright/mcp",
  description: "Browser automation", needs_api_key: false,
};

/** The broker's /mcpservers/user/* routes, held in memory. */
async function fakeBroker(page: Page) {
  const servers: Server[] = [];
  let next = 0;
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/contrib-api/mcpservers/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^.*\/contrib-api\/mcpservers\//, "");
    const body = req.postData() ? JSON.parse(req.postData()!) : {};
    if (path === "catalog") return json(route, CATALOG);
    if (path === "registry") {
      return json(route, { servers: url.searchParams.get("q") === "playwright" ? [REGISTRY_HIT] : [] });
    }
    if (path === "servers" && req.method() === "GET") return json(route, { servers });
    if (path === "servers" && req.method() === "POST") {
      if (String(body.spec).includes(" ")) return json(route, { detail: "expected a PyPI package, optionally ==version" }, 400);
      const s: Server = { id: `s${next++}`, name: body.name, kind: body.kind, spec: body.spec, args: body.args, enabled: true };
      servers.push(s);
      return json(route, { server: s });
    }
    const m = path.match(/^servers\/(.+)$/);
    const s = m && servers.find((x) => x.id === m[1]);
    if (!s) return json(route, { detail: "no such server" }, 404);
    if (req.method() === "DELETE") {
      servers.splice(servers.indexOf(s), 1);
      return json(route, { deleted: s.id });
    }
    Object.assign(s, body);
    return json(route, { server: s });
  });
}

const rows = (page: Page) => page.locator('[data-testid="mcp-server-item"]');

test.describe("MCP servers settings tab", () => {
  test("shows its error card while the broker routes are unavailable", async ({ page }) => {
    await serveTab(page);
    await page.route("**/contrib-api/mcpservers/**", (route) =>
      route.fulfill({ status: 501, contentType: "text/plain", body: "not implemented" }),
    );
    await page.goto("/settings/mcpservers");
    await expect(page.getByText("Couldn't load your MCP servers")).toBeVisible({ timeout: 20_000 });
  });

  test("a server survives add, toggle and remove", async ({ page }) => {
    await serveTab(page);
    await fakeBroker(page);
    await page.goto("/settings/mcpservers");
    await expect(page.locator('[data-testid="mcp-servers-empty"]')).toBeVisible({ timeout: 20_000 });

    await page.locator('[data-testid="mcp-server-new"]').click();
    await page.locator('[data-testid="mcp-server-custom"]').click();
    await page.locator('[data-testid="mcp-server-kind-pypi"]').click();
    await page.locator('[data-testid="mcp-server-spec"]').fill("mcp-server-fetch==2025.4.7");
    // The name follows the package until it is edited.
    await expect(page.locator('[data-testid="mcp-server-name"]')).toHaveValue("fetch");
    await page.locator('[data-testid="mcp-server-args"]').fill("--ignore-robots-txt\n--user-agent=Scooter");
    await page.locator('[data-testid="mcp-server-submit"]').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("fetch");
    await expect(rows(page).first()).toContainText("mcp-server-fetch==2025.4.7 --ignore-robots-txt --user-agent=Scooter");

    await page.locator('[data-testid="mcp-server-toggle"]').click();
    await expect(rows(page).first()).toHaveAttribute("data-enabled", "false");

    page.once("dialog", (d) => void d.accept());
    await page.locator('[data-testid="mcp-server-delete"]').click();
    await expect(rows(page)).toHaveCount(0);
  });

  test("a catalog entry adds in one click; a keyed one stays greyed out", async ({ page }) => {
    await serveTab(page);
    await fakeBroker(page);
    await page.goto("/settings/mcpservers");
    await page.locator('[data-testid="mcp-server-new"]').click({ timeout: 20_000 });

    const items = page.locator('[data-testid="mcp-catalog-item"]');
    await expect(items).toHaveCount(2);
    const keyed = items.filter({ hasText: "github" });
    await expect(keyed.locator('[data-testid="mcp-catalog-keyed"]')).toHaveText("needs an API key");
    await expect(keyed.locator('[data-testid="mcp-catalog-add"]')).toHaveCount(0);

    await items.filter({ hasText: "fetch" }).locator('[data-testid="mcp-catalog-add"]').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("mcp-server-fetch");
    // The browser stays open and the entry flips to added.
    await expect(page.locator('[data-testid="mcp-catalog-added"]')).toBeVisible();
  });

  test("a registry search result prefills the form", async ({ page }) => {
    await serveTab(page);
    await fakeBroker(page);
    await page.goto("/settings/mcpservers");
    await page.locator('[data-testid="mcp-server-new"]').click({ timeout: 20_000 });

    await page.locator('[data-testid="mcp-catalog-search"]').fill("playwright");
    const hit = page.locator('[data-testid="mcp-catalog-item"]', { hasText: "io.github.microsoft/playwright-mcp" });
    await hit.locator('[data-testid="mcp-catalog-edit"]').click();
    await expect(page.locator('[data-testid="mcp-server-spec"]')).toHaveValue("@playwright/mcp");
    await expect(page.locator('[data-testid="mcp-server-name"]')).toHaveValue("playwright");
    await page.locator('[data-testid="mcp-server-submit"]').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("@playwright/mcp");
  });

  test("a refused package shows the server's reason and keeps the form open", async ({ page }) => {
    await serveTab(page);
    await fakeBroker(page);
    await page.goto("/settings/mcpservers");
    await page.locator('[data-testid="mcp-server-new"]').click({ timeout: 20_000 });
    await page.locator('[data-testid="mcp-server-custom"]').click();
    await page.locator('[data-testid="mcp-server-kind-pypi"]').click();
    await page.locator('[data-testid="mcp-server-spec"]').fill("pkg --index-url x");
    await page.locator('[data-testid="mcp-server-name"]').fill("pkg");
    await page.locator('[data-testid="mcp-server-submit"]').click();
    await expect(page.locator('[data-testid="mcp-server-error"]')).toContainText("PyPI package");
    await expect(page.locator('[data-testid="mcp-server-form"]')).toBeVisible();
  });
});
