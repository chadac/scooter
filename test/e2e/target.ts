/**
 * Which TARGET a spec runs against.
 *
 * The same specs run against two very different stacks:
 *
 *   fast (default) — the local fake stack. The browser, the UI, and agent-host are
 *                    all REAL; the agent (GOOSE_BIN=fake) and the sandbox/cluster
 *                    are faked. Fast, deterministic, no cluster.
 *   full           — a REAL cluster (k3d in CI, or a live deployment). Slow, but the
 *                    only place the browser meets the real server. That seam is where
 *                    a client-minted conversation id reached the URL and made scooter
 *                    unusable while every fast test passed.
 *
 * full is NOT a superset of fast: fault-proxy specs (SSE resilience, stream
 * corruption) only run fast — the proxy cannot sit inside the cluster path. They are
 * targets a spec supports, not rungs on a ladder.
 *
 * Most specs need NO changes to run against a cluster — they depend only on
 * `fixtures.js`, which resolves everything from Playwright's `baseURL`. So the default
 * is "runs on both", and a spec opts OUT only when it genuinely cannot work somewhere.
 *
 * Prefer `fastOnly` / `fullOnly` over a bare `test.skip`: the reason is recorded,
 * `--project` selection does the filtering, and a reader can see at a glance why a
 * spec does not run everywhere.
 */
import { test } from "@playwright/test";

/** The target this run drives. Set by the Playwright project, not by a spec. */
export const TARGET: "fast" | "full" = process.env.E2E_TARGET === "full" ? "full" : "fast";

/** True when running against a real cluster / live deployment. */
export const isFull = TARGET === "full";

/**
 * Skip this describe block except on the fast (fake) stack.
 *
 * For specs that need something only the fake stack has: the SSE fault proxy, a
 * deterministic agent script, or a wipe of ALL conversations.
 */
export function fastOnly(reason: string): typeof test.describe {
  return TARGET === "fast" ? test.describe : skipWith(`fast only — ${reason}`);
}

/**
 * Skip this describe block except on the full (real-cluster) target.
 *
 * For stories the fake stack CANNOT express: multi-pod routing, a rollout mid-turn, a
 * real sandbox exec. These are the reason the full target exists at all.
 */
export function fullOnly(reason: string): typeof test.describe {
  return TARGET === "full" ? test.describe : skipWith(`full only — ${reason}`);
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
