import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";

// The full-target allowlist lives in test/e2e/full-specs.json, shared with CI's shard
// distribution (shard-e2e.mjs SPEC_SET=full).
const fullSpecs: string[] = JSON.parse(
  readFileSync(new URL("./test/e2e/full-specs.json", import.meta.url), "utf8"),
);

/**
 * Tier 3 E2E config. The default mode boots the full local stack (agent-host in fake-agent
 * mode + the UI dev server) so tests drive the real UI end to end with no cluster or model.
 * External mode (RUN_EXTERNAL_E2E=1, AGENT_HOST_URL=<live agent-host>) skips the local
 * webServer and points test/e2e/external.spec.ts at a live deployment.
 */
const external = process.env.RUN_EXTERNAL_E2E === "1";

// The full target (E2E_TARGET=full + E2E_CLUSTER_URL=<ui>) runs the same specs against a
// real cluster, the only place the browser meets the real server.
const full = process.env.E2E_TARGET === "full";
const clusterUrl = process.env.E2E_CLUSTER_URL ?? "";
// Set by .github/scripts/e2e-full-serve.sh when the platform has per-conversation service origins.
const sandboxRules =
  process.env.E2E_SANDBOX_DOMAIN && process.env.E2E_SANDBOX_EDGE
    ? `MAP *.${process.env.E2E_SANDBOX_DOMAIN} ${process.env.E2E_SANDBOX_EDGE}`
    : undefined;

export default defineConfig({
  testDir: "./test/e2e",
  // test/e2e/support holds the harness and its vitest specs, which playwright's default
  // testMatch would otherwise load as browser tests.
  testIgnore: "**/support/**",
  // The full-target ceiling must exceed the helpers it contains (startLongRun waits 90s
  // there, completeTurn 120s).
  timeout: full ? 180_000 : 60_000,
  expect: { timeout: 15_000 },
  // The whole suite shares one agent-host webServer and its persisted conversation state,
  // so the backend is a serial resource.
  fullyParallel: false,
  workers: 1,
  // No retries: a flake is a signal to fix or quarantine.
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5173",
    // retain-on-failure, because retries are 0 and "on-first-retry" would capture nothing.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // full: a real cluster with no local webServer; only the specs that opt in run here
    // (see test/e2e/target.ts).
    ...(full
      ? [
          {
            name: "full",
            // Add a spec here once it has passed against a cluster; do not bulk-enable.
            testMatch: fullSpecs.map((f) => `**/${f}`),
            use: {
              ...devices["Desktop Chrome"],
              baseURL: clusterUrl,
              // Sandbox origins (https://<label>.<domain>/) resolve to the local edge that
              // stands in for the wildcard Ingress; its certificate is self-signed.
              ...(sandboxRules ? { ignoreHTTPSErrors: true } : {}),
              launchOptions: {
                ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}),
                ...(sandboxRules ? { args: [`--host-resolver-rules=${sandboxRules}`] } : {}),
              },
            },
          },
        ]
      : []),
    {
      name: "fast",
      use: {
        ...devices["Desktop Chrome"],
        // On Nix, PW_CHROME points at the nix chromium binary; unset elsewhere means the
        // default download.
        ...(process.env.PW_CHROME
          ? { launchOptions: { executablePath: process.env.PW_CHROME } }
          : {}),
      },
    },
  ],

  // External mode targets a live deployment and the full target's cluster is already
  // running, so neither boots local servers.
  webServer: external || full
    ? undefined
    : [
        {
          // The fake backend stack: ephemeral Postgres → atlas migrate → agent-host (fake agent)
          // → conversation-router (ROUTER_DEV_MODE), all as one process; the UI targets the
          // router on 8080, which proxies to agent-host on 8079.
          command: "node test/e2e/support/fakeBackend.mjs",
          // SIGTERM so cleanup() stops the pg_ctl-daemonized Postgres.
          gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
          env: {
            E2E_ROUTER_PORT: "8080",
            E2E_AGENT_HOST_PORT: "8079",
            E2E_AGENT_HOST_REPLICA_PORT: "8078",
            LOCAL_STATE_PATH: "/tmp/agent-host-e2e",
            // Production's two-store topology: mirroredConversationStore is only constructed
            // when MIRROR_STATE_PATH is set.
            MIRROR_STATE_PATH: "/tmp/agent-host-e2e-mirror",
            GOOSE_MODEL: "model-default",
            AGENT_AVAILABLE_MODELS: "model-default,model-fast,model-smart",
            // A provider-tagged catalog so the picker renders its grouped branch, with one model on both providers, one on each alone, and a per-provider default.
            AGENT_MODELS_JSON: JSON.stringify([
              { id: "model-default", providers: ["byoc", "claude-code"], defaultFor: ["byoc", "claude-code"] },
              { id: "model-fast", providers: ["claude-code"] },
              { id: "model-smart", providers: ["byoc"] },
            ]),
            // The MCP endpoint resolves its conversation from a signed token, so without a signing key the fake agent's `~subagent` directive fails.
            CONV_TOKEN_SECRET: "e2e-fake-stack-conv-token-secret",
          },
          // Wait on the router's /healthz (proxied to agent-host) so the whole chain is serving
          // before tests start.
          url: "http://localhost:8080/healthz",
          // PG init + migrate + three service boots need headroom on a cold runner.
          timeout: 120_000,
          // Reuse is opt-in locally (E2E_REUSE_SERVER=1): a leftover server keeps serving its old build.
          reuseExistingServer: !process.env.CI && process.env.E2E_REUSE_SERVER === "1",
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          // The default UI dev server, 5173 -> agent-host 8080 directly, used by every spec except the SSE-resilience one.
          command: "npm --prefix services/ui run dev",
          env: {
            AGENT_HOST_URL: "http://localhost:8080",
            // E2E_TELEMETRY=1 emits a span per line to the browser console, off by default because it buries real console errors.
            ...(process.env.E2E_TELEMETRY === "1" ? { VITE_TELEMETRY_CONSOLE: "1" } : {}),
          },
          // Wait on `url` rather than `port`, since Vite binds its port instantly but compiles the app lazily on the first request.
          url: "http://localhost:5173",
          timeout: 120_000,
          // Reuse is opt-in locally (E2E_REUSE_SERVER=1): a leftover server keeps serving its old build.
          reuseExistingServer: !process.env.CI && process.env.E2E_REUSE_SERVER === "1",
        },
        // --- SSE-resilience-only stack (isolated on its own ports) ----------------
        {
          // SSE fault proxy between a second UI dev server and agent-host, so the resilience
          // spec can drop/stall/kill integrity-stream frames or return 401 (see faultProxy.mjs).
          command: "node test/e2e/support/faultProxy.mjs",
          env: { FAULT_PROXY_PORT: "8090", AGENT_HOST_PORT: "8080" },
          port: 8090,
          // Reuse is opt-in locally (E2E_REUSE_SERVER=1): a leftover server keeps serving its old build.
          reuseExistingServer: !process.env.CI && process.env.E2E_REUSE_SERVER === "1",
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          // A second UI dev server (port 5273) with a small idle-watchdog; only the integrity
          // stream is routed through the fault proxy, and only the SSE-resilience spec targets it.
          command: "npm --prefix services/ui run dev -- --port 5273",
          env: {
            AGENT_HOST_URL: "http://localhost:8080",
            AGENT_HOST_STREAM_URL: "http://localhost:8090",
            VITE_IDLE_RECONNECT_MS: "2000",
            VITE_CACHE_DIR: "node_modules/.vite-5273",
            ...(process.env.E2E_TELEMETRY === "1" ? { VITE_TELEMETRY_CONSOLE: "1" } : {}),
          },
          // Same cold-compile warm-up as the 5173 server.
          url: "http://localhost:5273",
          timeout: 120_000,
          // Reuse is opt-in locally (E2E_REUSE_SERVER=1): a leftover server keeps serving its old build.
          reuseExistingServer: !process.env.CI && process.env.E2E_REUSE_SERVER === "1",
        },
      ],
});
