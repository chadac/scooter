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

// TIER 2: the same specs, against a REAL cluster (k3d in CI, or a live deployment).
// The browser/real-server seam is otherwise untested — Tier 3 drives a UI with no real
// cluster, and test/cluster drives a real cluster with no UI, so a bug living between
// them is invisible to both. E2E_TIER=2 + E2E_CLUSTER_URL=<ui> selects it.
const tier2 = process.env.E2E_TIER === "2";
const clusterUrl = process.env.E2E_CLUSTER_URL ?? "";

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
    // NOT "on-first-retry": retries are 0 by policy (above), so a first retry never happens and
    // that setting would capture NOTHING on failure. retain-on-failure keeps the no-retry policy
    // while still producing the trace that makes a hang diagnosable.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Tier 2 — a real cluster. Only the specs that opt in (or do not opt out) run here;
    // see test/e2e/tier.ts. No local webServer: the stack is already up.
    ...(tier2
      ? [
          {
            name: "cluster",
            // START SMALL, WIDEN AS IT EARNS IT. A cluster run costs k3d startup and
            // this tier is the one nobody watches, so 153 specs on day one buys noise,
            // not confidence — and a flaky rarely-run tier trains everyone to dismiss
            // it (see FLAKE_platform_smoke_empty_create_body). These are the user
            // stories that justify the tier existing:
            //   cluster-stories      — multi-pod + rollout; impossible in Tier 3
            //   client-server-identity — the class that shipped (#353)
            //   refresh-history      — "send a message, see the response", across a reload
            //   stop-run             — a run starts and can be stopped, for real
            // Add a spec here once it has passed against a cluster; do not bulk-enable.
            testMatch: [
              /cluster-stories\.spec\.ts/,
              /client-server-identity\.spec\.ts/,
              /refresh-history\.spec\.ts/,
              /stop-run\.spec\.ts/,
            ],
            use: {
              ...devices["Desktop Chrome"],
              baseURL: clusterUrl,
              ...(process.env.PW_CHROME
                ? { launchOptions: { executablePath: process.env.PW_CHROME } }
                : {}),
            },
          },
        ]
      : []),
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
  // Tier 2 targets a cluster that is already running, so boot nothing locally.
  webServer: external || tier2
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
            LOCAL_STATE_PATH: "/tmp/agent-host-e2e",
            // Run PRODUCTION's two-store topology. mirroredConversationStore is only
            // constructed when MIRROR_STATE_PATH is set (index.ts:189, :442) — without it
            // the e2e stack ran a single-store shape production NEVER runs, so every
            // local-vs-mirror divergence was structurally untestable here. That is exactly
            // how `listLinks` reading the wiped emptyDir reached production.
            MIRROR_STATE_PATH: "/tmp/agent-host-e2e-mirror",
            GOOSE_MODEL: "model-default",
            AGENT_AVAILABLE_MODELS: "model-default,model-fast,model-smart",
          },
          // Wait on the readiness ROUTE (GET /healthz -> 200), not a bare port bind,
          // so the server is actually serving before tests start.
          url: "http://localhost:8080/healthz",
          // Reuse is opt-IN locally (E2E_REUSE_SERVER=1), not the default. A server left over from
          // an earlier run keeps serving its OLD build, so a fresh run silently tests stale code:
          // identical specs then yield different failure counts and any baseline/before-after
          // comparison is worthless. That cost a long debugging detour once — default to a clean
          // build and let the caller opt into reuse when iterating on test code alone.
          reuseExistingServer: !process.env.CI && process.env.E2E_REUSE_SERVER === "1",
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          // The DEFAULT UI dev server — unchanged, 5173 -> agent-host 8080 directly.
          // EVERY spec except the SSE-resilience one uses this untouched stack, so
          // the fault proxy + small idle-watchdog below can't perturb them.
          //
          // Wait on `url` (a real GET of the page), NOT `port`. Vite binds its port
          // instantly but compiles the app LAZILY on the first request — a bare
          // port-bind check lets tests start before the first navigation can serve,
          // and the cold first-compile (several seconds on a fresh CI runner) then
          // eats the opening tests as `chat.open()` timeouts. Fetching the page here
          // forces that compile ONCE at boot; `timeout` gives it room. This got much
          // worse under sharding: each shard boots its own cold Vite.
          command: "npm --prefix ui run dev",
          env: {
            AGENT_HOST_URL: "http://localhost:8080",
            // Span-per-line to the browser console when debugging a spec:
            //   E2E_TELEMETRY=1 npx playwright test <spec>
            // Off by default — a chat UI emits enough spans to bury real console errors.
            ...(process.env.E2E_TELEMETRY === "1" ? { VITE_TELEMETRY_CONSOLE: "1" } : {}),
          },
          url: "http://localhost:5173",
          timeout: 120_000,
          // Reuse is opt-IN locally (E2E_REUSE_SERVER=1), not the default. A server left over from
          // an earlier run keeps serving its OLD build, so a fresh run silently tests stale code:
          // identical specs then yield different failure counts and any baseline/before-after
          // comparison is worthless. That cost a long debugging detour once — default to a clean
          // build and let the caller opt into reuse when iterating on test code alone.
          reuseExistingServer: !process.env.CI && process.env.E2E_REUSE_SERVER === "1",
        },
        // --- SSE-resilience-only stack (isolated on its own ports) ----------------
        {
          // SSE fault proxy: sits between a SECOND UI dev server and agent-host so
          // the resilience spec can drop/stall/kill integrity-stream frames or
          // return 401. Pass-through when no fault is set. See faultProxy.mjs.
          command: "node test/e2e/support/faultProxy.mjs",
          env: { FAULT_PROXY_PORT: "8090", AGENT_HOST_PORT: "8080" },
          port: 8090,
          // Reuse is opt-IN locally (E2E_REUSE_SERVER=1), not the default. A server left over from
          // an earlier run keeps serving its OLD build, so a fresh run silently tests stale code:
          // identical specs then yield different failure counts and any baseline/before-after
          // comparison is worthless. That cost a long debugging detour once — default to a clean
          // build and let the caller opt into reuse when iterating on test code alone.
          reuseExistingServer: !process.env.CI && process.env.E2E_REUSE_SERVER === "1",
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
            ...(process.env.E2E_TELEMETRY === "1" ? { VITE_TELEMETRY_CONSOLE: "1" } : {}),
          },
          // Same cold-compile warm-up as the 5173 server — GET the page until it 200s.
          url: "http://localhost:5273",
          timeout: 120_000,
          // Reuse is opt-IN locally (E2E_REUSE_SERVER=1), not the default. A server left over from
          // an earlier run keeps serving its OLD build, so a fresh run silently tests stale code:
          // identical specs then yield different failure counts and any baseline/before-after
          // comparison is worthless. That cost a long debugging detour once — default to a clean
          // build and let the caller opt into reuse when iterating on test code alone.
          reuseExistingServer: !process.env.CI && process.env.E2E_REUSE_SERVER === "1",
        },
      ],
});
