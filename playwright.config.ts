import { defineConfig, devices } from "@playwright/test";

/**
 * Tier 3 E2E config. Targets a deployed agent-host + UI.
 * BASE_URL points at the running stack (default: local port-forward / dev server).
 */
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false, // conversations hold cluster resources; keep it tame
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8080",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
