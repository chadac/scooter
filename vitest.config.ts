import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Three non-E2E projects:
 *   - agent-host : Tier 1 contract tests (fast, no cluster). `npm test`.
 *   - ui         : UI unit tests (client lib + pure view-model logic). Fast, no
 *                  browser. A broken import (e.g. a dropped react-icons icon)
 *                  fails here instead of only at `tsc` / not at all.
 *   - cluster    : Tier 2 against a real cluster. `npm run test:cluster`
 *                  (each spec self-skips unless RUN_CLUSTER_TESTS=1).
 * Tier 3 (Playwright) is configured separately in playwright.config.ts.
 */
export default defineConfig({
  test: {
    // Always print per-test names + pass/fail (so a single run shows exactly
    // what failed — no need to re-run with --reporter=verbose).
    reporters: process.env.CI ? ["default"] : ["verbose"],
    projects: [
      {
        test: {
          name: "agent-host",
          include: ["services/agent-host/test/contract/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
        // Match ui/vite.config.ts's "@" -> ui/ alias so tests can import the
        // assistant-ui components (e.g. @/components/assistant-ui/...) the app uses.
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
