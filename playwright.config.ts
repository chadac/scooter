import { defineConfig, devices } from "@playwright/test";

/**
 * Tier 3 E2E config. Boots the full local stack (agent-host in fake-agent mode
 * + the UI dev server) so tests drive the real UI end to end with no cluster
 * or model needed. The dummy ACP agent gives deterministic streamed responses.
 */
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      // agent-host in fake mode: no cluster, no model.
      command:
        "node services/agent-host/dist/index.js",
      env: { PORT: "8080", GOOSE_BIN: "fake", STATE_PATH: "/tmp/agent-host-e2e" },
      port: 8080,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm --prefix ui run dev",
      env: { AGENT_HOST_URL: "http://localhost:8080" },
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
