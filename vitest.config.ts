import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The vitest projects: agent-host contract tests, the UI unit tests, the per-service unit
 * suites, and the cluster integration tests (each spec self-skips unless
 * RUN_CLUSTER_TESTS=1). Tier 3 (Playwright) is configured separately in
 * playwright.config.ts.
 */
export default defineConfig({
  test: {
    // Print per-test names and pass/fail so a single run shows exactly what failed.
    reporters: process.env.CI ? ["default"] : ["verbose"],
    // TEST_RANDOMIZE=1 shuffles test order to surface ordering-dependent flakes, and
    // TEST_SEED=<number> pins the seed.
    sequence: {
      shuffle: process.env.TEST_RANDOMIZE === "1",
      seed: process.env.TEST_SEED ? parseInt(process.env.TEST_SEED, 10) : Date.now(),
    },
    projects: [
      {
        test: {
          name: "agent-host",
          include: ["services/agent-host/test/contract/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
        // @scooter/schema, the generated Drizzle schema; its units guard the hand-written
        // ownership manifest and the runtime db guard.
        test: {
          name: "scooter-schema",
          include: ["lib/ts/scooter-schema/src/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
        // The BYO-Claude container, whose wire handling is contract-tested against the frames
        // the controller emits.
        test: {
          name: "remote-agent",
          include: ["services/remote-agent/test/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
        // The in-sandbox Agent Host Protocol server VS Code bridges to: AG-UI -> AHP mapping.
        test: {
          name: "vscode-ahp",
          include: ["contrib/code-server/ahp/test/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
        // The BYOC controller, which holds the bring-your-own-Claude container sockets so any
        // agent-host replica can drive them.
        test: {
          name: "byoc-controller",
          include: ["services/byoc-controller/test/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
        // The isolated Claude Agent SDK provider; its SDK→AG-UI adapter and sandbox MCP tool
        // handlers are contract-tested here.
        test: {
          name: "claude-sdk-provider",
          include: ["services/claude-sdk-provider/src/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
        // Cross-service: agent-host, byoc-controller and the BYO container together.
        test: {
          name: "integration",
          include: ["test/integration/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
        // CI helper scripts, whose verdict logic is unreachable from the CI job itself;
        // the shard planner is one of them.
        test: {
          name: "ci-scripts",
          include: ["scripts/**/*.spec.mjs", "test/e2e/support/**/*.spec.mjs"],
          environment: "node",
        },
      },
      {
        // Match ui/vite.config.ts's "@" -> ui/ alias so tests can import the app's components.
        resolve: {
          alias: { "@": fileURLToPath(new URL("./ui/", import.meta.url)) },
        },
        test: {
          name: "ui",
          include: ["ui/src/**/*.{test,spec}.{ts,tsx}"],
          environment: "node",
        },
      },
      {
        // The cluster fixture's own pure helpers, which the Tier 2 specs reach only with a
        // cluster up — the curl-pod retry among them.
        test: {
          name: "cluster-support",
          include: ["test/support/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "cluster",
          include: ["test/cluster/**/*.spec.ts"],
          environment: "node",
          testTimeout: 240_000,
          hookTimeout: 240_000,
          // Cluster specs share one namespace's resources, so run them sequentially.
          fileParallelism: false,
        },
      },
    ],
  },
});
