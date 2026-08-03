import { defineConfig, devices } from "@playwright/test";

/**
 * Tier 3 E2E config. Two modes:
 *
 *  - DEFAULT: boots the full local stack (agent-host in fake-agent mode + the UI
 *    dev server) so tests drive the real UI end to end with no cluster or model.
 *    The dummy ACP agent gives deterministic streamed responses.
 *
 *  - EXTERNAL (RUN_EXTERNAL_E2E=1, AGENT_HOST_URL=<live agent-host>): skips the
 *    local webServer and points the external spec at a LIVE deployment, so a
 *    real conversation runs a real shell tool call against a real sandbox —
 *    catching in-cluster failures (e.g. the pods/exec WebSocket) the fake stack
 *    can't. See test/e2e/external.spec.ts.
 */
const external = process.env.RUN_EXTERNAL_E2E === "1";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // The whole suite shares ONE agent-host webServer + its persisted conversation
  // state (the `cleanState` fixture wipes conversations between tests). Running
  // spec FILES in parallel (multiple workers) lets that shared state interleave —
  // one spec's conversations/streams leak into another's assertions (observed:
  // ~6 fail + 4 flaky in parallel vs green serially). So the backend is a serial
  // resource: one worker. (fullyParallel is already false = serial within a file.)
  fullyParallel: false,
  workers: 1,
  // No retries: a flake is a signal to fix or quarantine, not to paper over. A
  // test that only passes on retry is reported and dealt with deliberately.
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // On Nix the npm-downloaded browser revision often doesn't match the
        // playwright-driver build; PW_CHROME points at the nix chromium binary
        // (set in the dev shell / CI). Unset elsewhere -> default download.
        ...(process.env.PW_CHROME
          ? { launchOptions: { executablePath: process.env.PW_CHROME } }
          : {}),
      },
    },
  ],

  // External mode targets a live deployment, so boot no local servers.
  webServer: external
    ? undefined
    : [
        {
          // agent-host in fake mode: no cluster. A default + offered models so
          // the model-selection UI has a catalog to pick from (the fake agent
          // echoes its GOOSE_MODEL via the "~model" directive).
          command: "node services/agent-host/dist/index.js",
          env: {
            PORT: "8080",
            GOOSE_BIN: "fake",
            STATE_PATH: "/tmp/agent-host-e2e",
            GOOSE_MODEL: "model-default",
            AGENT_AVAILABLE_MODELS: "model-default,model-fast,model-smart",
          },
          port: 8080,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          // The DEFAULT UI dev server — unchanged, 5173 -> agent-host 8080 directly.
          // EVERY spec except the SSE-resilience one uses this untouched stack, so
          // the fault proxy + small idle-watchdog below can't perturb them.
          command: "npm --prefix ui run dev",
          env: { AGENT_HOST_URL: "http://localhost:8080" },
          port: 5173,
          reuseExistingServer: !process.env.CI,
        },
        // --- SSE-resilience-only stack (isolated on its own ports) ----------------
        {
          // SSE fault proxy: sits between a SECOND UI dev server and agent-host so
          // the resilience spec can drop/stall/kill integrity-stream frames or
          // return 401. Pass-through when no fault is set. See faultProxy.mjs.
          command: "node test/e2e/support/faultProxy.mjs",
          env: { FAULT_PROXY_PORT: "8090", AGENT_HOST_PORT: "8080" },
          port: 8090,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          // A SECOND UI dev server (port 5273) with a small idle-watchdog so
          // recovery fires in seconds. ONLY the integrity STREAM is routed through
          // the fault proxy (AGENT_HOST_STREAM_URL); every other API call goes
          // straight to agent-host (AGENT_HOST_URL) so multi-turn sends aren't
          // raced/400'd by the extra hop. ONLY the SSE-resilience spec targets this
          // (via its baseURL); the default 5173 stack is pristine for other specs.
          command: "npm --prefix ui run dev -- --port 5273",
          env: {
            AGENT_HOST_URL: "http://localhost:8080",
            AGENT_HOST_STREAM_URL: "http://localhost:8090",
            VITE_IDLE_RECONNECT_MS: "2000",
          },
          port: 5273,
          reuseExistingServer: !process.env.CI,
        },
      ],
});
