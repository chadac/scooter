/**
 * Which TIER a spec runs in.
 *
 * The same specs run against two very different targets:
 *
 *   Tier 3 (default) — the local fake stack. Fast, deterministic, no cluster.
 *   Tier 2           — a REAL cluster (k3d in CI, or a live deployment). Slow, but the
 *                      only place the browser meets the real server. That seam is where
 *                      a client-minted conversation id reached the URL and made scooter
 *                      unusable while all 122 Tier-3 tests passed.
 *
 * 26 of 31 specs need NO changes to run against a cluster — they depend only on
 * `fixtures.js`, which resolves everything from Playwright's `baseURL`. So the default
 * is "runs in both", and a spec opts OUT only when it genuinely cannot work somewhere.
 *
 * Prefer `tier3Only` / `tier2Only` over a bare `test.skip`: the reason is recorded,
 * `--project` selection does the filtering, and a reader can see at a glance why a spec
 * does not run everywhere.
 */
import { test } from "@playwright/test";

/** The tier this run targets. Set by the Playwright project, not by a spec. */
export const TIER: 2 | 3 = process.env.E2E_TIER === "2" ? 2 : 3;

/** True when running against a real cluster / live deployment. */
export const isCluster = TIER === 2;

/**
 * Skip this describe block outside Tier 3 (the fake stack).
 *
 * For specs that need something only the fake stack has: the SSE fault proxy, a
 * deterministic agent script, or a wipe of ALL conversations.
 */
export function tier3Only(reason: string): typeof test.describe {
  return TIER === 3 ? test.describe : skipWith(`Tier 3 only — ${reason}`);
}

/**
 * Skip this describe block outside Tier 2 (a real cluster).
 *
 * For stories the fake stack CANNOT express: multi-pod routing, a rollout mid-turn, a
 * real sandbox exec. These are the reason Tier 2 exists at all.
 */
export function tier2Only(reason: string): typeof test.describe {
  return TIER === 2 ? test.describe : skipWith(`Tier 2 only — ${reason}`);
}

/** A describe that skips, carrying its reason into the report. */
function skipWith(reason: string): typeof test.describe {
  const skipped = ((title: string, body: () => void) =>
    test.describe(title, () => {
      test.skip(true, reason);
      body();
    })) as unknown as typeof test.describe;
  return Object.assign(skipped, test.describe);
}
