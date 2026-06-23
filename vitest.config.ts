import { defineConfig } from "vitest/config";

/**
 * Two non-E2E projects:
 *   - agent-host : Tier 1 contract tests (fast, no cluster). `npm test`.
 *   - cluster    : Tier 2 against a real cluster. `npm run test:cluster`
 *                  (each spec self-skips unless RUN_CLUSTER_TESTS=1).
 * Tier 3 (Playwright) is configured separately in playwright.config.ts.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "agent-host",
          include: ["services/agent-host/test/contract/**/*.spec.ts"],
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
          // Cluster specs share one namespace's resources — run them
          // sequentially to avoid cross-spec races.
          fileParallelism: false,
        },
      },
    ],
  },
});
