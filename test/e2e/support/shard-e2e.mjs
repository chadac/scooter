#!/usr/bin/env node
/**
 * Distribute the Playwright e2e spec FILES into N balanced shards for parallel CI
 * runners, weighted by per-file runtime.
 *
 * Each spec's weight is the MAX of:
 *   1. Measured durations — a window of recent Playwright JSON reports
 *      (PRIOR_REPORT_DIR=dir, per-spec max across them) or a single one (PRIOR_REPORT=path).
 *   2. A committed table — shard-weights.full.json for SPEC_SET=full, else
 *      shard-weights.json. Per-target because the two suites' runtimes differ ~3x.
 *   3. A flat DEFAULT_WEIGHT for any spec absent from both.
 * MAX rather than "first source that knows", because every way a weight goes WRONG here
 * makes it too SMALL (a truncated report, a stale table), and too-small is the one that
 * overloads a shard.
 *
 * Bin-packing: Longest-Processing-Time-first (LPT) greedy — sort files heaviest-first,
 * assign each to the currently-lightest shard. Near-optimal makespan for this size.
 *
 * Output: prints a GitHub-Actions matrix include list as JSON to stdout, e.g.
 *   {"include":[{"shard":1,"specs":"a.spec.ts b.spec.ts"},{"shard":2,"specs":"c.spec.ts"}]}
 * Each `specs` is a space-joined list of spec FILE PATHS (relative to repo root),
 * ready to pass positionally to `playwright test`.
 *
 * Usage:  node test/e2e/support/shard-e2e.mjs <N>
 *         SHARDS=<N> node test/e2e/support/shard-e2e.mjs
 *         PRIOR_REPORT=prev/report.json node test/e2e/support/shard-e2e.mjs 4
 *         SPEC_SET=full PRIOR_REPORT_DIR=prior node test/e2e/support/shard-e2e.mjs 4
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(HERE, ".."); // test/e2e
const REPO_ROOT = join(E2E_DIR, "..", ".."); // scooter/
// Per-target fallback tables. The full target's numbers are ~3x the fast one's (a real
// sandbox pod per conversation), so one shared table cannot balance both suites.
const DEFAULTS_PATH = join(E2E_DIR, process.env.SPEC_SET === "full" ? "shard-weights.full.json" : "shard-weights.json");

const DEFAULT_WEIGHT = 30; // seconds — a middling spec, used when nothing else knows.

/** Spec files Playwright would consider. Default (fast): every *.spec.ts in
 *  test/e2e — specs that self-skip via env stay in the list: they're cheap no-ops on
 *  a shard and enumerating them keeps this in lock-step with the suite.
 *  SPEC_SET=full: the full-target allowlist (test/e2e/full-specs.json) — the SAME
 *  file playwright.config.ts builds the `full` project's testMatch from, so CI's
 *  shard plan and the project definition cannot drift. */
function specFiles() {
  if (process.env.SPEC_SET === "full") {
    return JSON.parse(readFileSync(join(E2E_DIR, "full-specs.json"), "utf8")).sort();
  }
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort(); // deterministic order → deterministic sharding for the same inputs
}

/** Committed fallback weights: { "<spec-file>": seconds }. Missing file → {}. */
function committedWeights() {
  if (!existsSync(DEFAULTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DEFAULTS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Per-spec-file durations (seconds) parsed from a Playwright JSON report, or {} if
 *  the report is absent/unreadable. Sums every test's duration within a file, so a
 *  file's weight reflects its whole cost. Playwright's JSON `suites` tree carries a
 *  `file` per top-level suite and `results[].duration` (ms) per test spec. */
export function priorReportWeights(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return {};
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return {};
  }
  const byFile = {};
  const addDuration = (file, ms) => {
    const key = basename(file);
    byFile[key] = (byFile[key] ?? 0) + (Number(ms) || 0);
  };
  // Walk the suite tree; a spec's `file` may live on the suite or the spec node.
  const walk = (node, inheritedFile) => {
    if (!node || typeof node !== "object") return;
    const file = node.file ?? inheritedFile;
    for (const spec of node.specs ?? []) {
      const specFile = spec.file ?? file;
      for (const test of spec.tests ?? []) {
        for (const res of test.results ?? []) addDuration(specFile, res.duration);
      }
    }
    for (const child of node.suites ?? []) walk(child, file);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file);
  // ms → seconds.
  const out = {};
  for (const [k, ms] of Object.entries(byFile)) out[k] = ms / 1000;
  return out;
}

/** Per-spec MAX across every report.json under `dir` (recursively — `gh run download`
 *  nests one directory per run). MAX, never a mean: a truncated run under-reports the
 *  specs it reached, and averaging that in is what overloads a shard. Why: PR #686. */
export function windowReportWeights(dir) {
  if (!dir || !existsSync(dir)) return {};
  const out = {};
  const walkDir = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walkDir(p);
      else if (ent.name.endsWith(".json")) {
        for (const [f, secs] of Object.entries(priorReportWeights(p))) {
          if (secs > 0) out[f] = Math.max(out[f] ?? 0, secs);
        }
      }
    }
  };
  walkDir(dir);
  return out;
}

/** Resolve each spec file's weight: max(measured, committed, DEFAULT_WEIGHT). */
export function resolveWeights(files, prior, committed) {
  const w = {};
  for (const f of files) {
    // Committed value is a FLOOR on the measured one, not a fallback — otherwise a spec
    // truncated by every run in the window stays under-weighted forever. Why: PR #686.
    const measured = prior[f] > 0 ? prior[f] : 0;
    const fallback = committed[f] > 0 ? committed[f] : DEFAULT_WEIGHT;
    w[f] = Math.max(measured, fallback);
  }
  return w;
}

/** LPT greedy bin-packing into `n` shards. Returns an array of { specs: string[],
 *  total: number }, each `specs` holding the repo-relative spec paths. */
export function packShards(files, weights, n) {
  const shards = Array.from({ length: n }, () => ({ specs: [], total: 0 }));
  const heaviestFirst = [...files].sort((a, b) => weights[b] - weights[a]);
  for (const f of heaviestFirst) {
    // Assign to the currently-lightest shard (ties → lowest index for determinism).
    let lightest = 0;
    for (let i = 1; i < n; i++) if (shards[i].total < shards[lightest].total) lightest = i;
    shards[lightest].specs.push(`test/e2e/${f}`);
    shards[lightest].total += weights[f];
  }
  return shards;
}

function main() {
  const n = Math.max(1, Number(process.argv[2] ?? process.env.SHARDS ?? 4));
  const files = specFiles();
  // PRIOR_REPORT_DIR (a window of runs, per-spec max) takes precedence over the single
  // PRIOR_REPORT; either may be empty, in which case the committed table carries it.
  const prior = process.env.PRIOR_REPORT_DIR
    ? windowReportWeights(process.env.PRIOR_REPORT_DIR)
    : priorReportWeights(process.env.PRIOR_REPORT);
  const committed = committedWeights();
  const weights = resolveWeights(files, prior, committed);

  const source = Object.keys(prior).length ? (process.env.PRIOR_REPORT_DIR ? "window-max" : "prior-report") : Object.keys(committed).length ? "committed-defaults" : "flat-default";
  const effN = Math.min(n, files.length) || 1; // don't create empty shards
  const shards = packShards(files, weights, effN)
    // Keep only non-empty shards (defensive; effN caps this already).
    .filter((s) => s.specs.length > 0);

  const include = shards.map((s, i) => ({
    shard: i + 1,
    specs: s.specs.join(" "),
    // Human-readable, not consumed by the matrix — handy in logs.
    est_seconds: Math.round(s.total),
  }));

  // Diagnostics to stderr so stdout stays pure JSON for `$(...)` capture.
  process.stderr.write(
    `[shard-e2e] ${files.length} specs → ${include.length} shards (weights: ${source})\n` +
      include.map((s) => `  shard ${s.shard}: ~${s.est_seconds}s — ${s.specs}`).join("\n") +
      "\n",
  );

  process.stdout.write(JSON.stringify({ include }));
}

// Run only as a CLI, so the spec can import the pure functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
