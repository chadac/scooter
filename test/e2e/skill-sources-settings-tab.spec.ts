/**
 * Tier 3 E2E for the skills contrib's settings tab: it renders from the manifest, shows
 * its error card while the broker routes are unreachable, and adds, toggles and removes a
 * source through /contrib-api. The fast stack runs no broker, so those routes are an
 * in-memory stand-in at the browser.
 */

import { type Page, type Route } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const TAB = { contrib: "skills", label: "Skill sources", order: 42, entry: "skills/ui/SettingsTab.tsx" };

async function serveTab(page: Page) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sources: {}, toolCards: {}, toolTitles: {}, linkProviders: [], approvals: {},
        settingsTabs: { "skills-sources": TAB },
      }),
    }),
  );
}

interface Source { id: string; kind: string; spec: string; skills: string[]; enabled: boolean }

/** The broker's /skills/user/* routes, held in memory. */
async function fakeBroker(page: Page) {
  const sources: Source[] = [];
  let next = 0;
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/contrib-api/skills/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/contrib-api\/skills\//, "");
    const body = req.postData() ? JSON.parse(req.postData()!) : {};
    if (path === "sources" && req.method() === "GET") return json(route, { sources });
    if (path === "sources" && req.method() === "POST") {
      if (String(body.spec).startsWith("-")) return json(route, { detail: "a skills.sh source is what you would pass to `npx skills add`" }, 400);
      const skills = String(body.skills ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const s: Source = { id: `s${next++}`, kind: body.kind, spec: body.spec, skills, enabled: true };
      sources.push(s);
      return json(route, { source: s });
    }
    const m = path.match(/^sources\/(.+)$/);
    const s = m && sources.find((x) => x.id === m[1]);
    if (!s) return json(route, { detail: "no such source" }, 404);
    if (req.method() === "DELETE") {
      sources.splice(sources.indexOf(s), 1);
      return json(route, { deleted: s.id });
    }
    Object.assign(s, body);
    return json(route, { source: s });
  });
}

const rows = (page: Page) => page.locator('[data-testid="skill-source-item"]');

test.describe("skill sources settings tab", () => {
  test("shows its error card while the broker routes are unavailable", async ({ page }) => {
    await serveTab(page);
    await page.route("**/contrib-api/skills/**", (route) =>
      route.fulfill({ status: 501, contentType: "text/plain", body: "not implemented" }),
    );
    await page.goto("/settings/skills-sources");
    await expect(page.getByText("Couldn't load your skill sources")).toBeVisible({ timeout: 20_000 });
  });

  test("a source survives add, toggle and remove", async ({ page }) => {
    await serveTab(page);
    await fakeBroker(page);
    await page.goto("/settings/skills-sources");
    await expect(page.locator('[data-testid="skill-sources-empty"]')).toBeVisible({ timeout: 20_000 });

    await page.locator('[data-testid="skill-source-new"]').click();
    await page.locator('[data-testid="skill-source-kind-github"]').click();
    await page.locator('[data-testid="skill-source-spec"]').fill("anthropics/skills");
    await page.locator('[data-testid="skill-source-filter"]').fill("pdf, docx");
    await page.locator('[data-testid="skill-source-submit"]').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("anthropics/skills");
    await expect(rows(page).first()).toContainText("Only pdf, docx");

    await page.locator('[data-testid="skill-source-toggle"]').click();
    await expect(rows(page).first()).toHaveAttribute("data-enabled", "false");

    page.once("dialog", (d) => void d.accept());
    await page.locator('[data-testid="skill-source-delete"]').click();
    await expect(rows(page)).toHaveCount(0);
  });

  test("a refused spec shows the server's reason and keeps the form open", async ({ page }) => {
    await serveTab(page);
    await fakeBroker(page);
    await page.goto("/settings/skills-sources");
    await page.locator('[data-testid="skill-source-new"]').click({ timeout: 20_000 });
    await page.locator('[data-testid="skill-source-spec"]').fill("-g");
    await page.locator('[data-testid="skill-source-submit"]').click();
    await expect(page.locator('[data-testid="skill-source-error"]')).toContainText("npx skills add");
    await expect(page.locator('[data-testid="skill-source-form"]')).toBeVisible();
  });
});
