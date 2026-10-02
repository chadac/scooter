#!/usr/bin/env node
/**
 * Distribute INDIVIDUAL TESTS (not spec files) into N balanced shards.
 *
 * WHY PER-TEST. File-level packing cannot balance this suite. From the 4-shard run
 * 36645763986: shard 1 got 5 tests / 139s while shard 3 got 41 tests / 1816s -- a
 * 12x spread -- because a file is an atomic unit and some files are enormous. The
 * worst single TEST is 347s (concurrency-divergence.spec.ts:68), longer than most
 * whole files, so no file-level assignment can smooth it. Per-test packing makes
 * 347s the floor on imbalance instead of ~540s (queue-durability.spec.ts, which is
 * really 2x175s tests plus others).
 *
 * It also dissolves the duplicated smoke work: `cluster smoke` ran platform-smoke +
 * event-backfill (127s + 30s) on EVERY shard against four identical clusters. Those
 * are 3 + 3 individual tests, so they schedule like anything else and run ONCE.
 *
 * ONE POOL for both runners. A shard carrying platform-smoke's slowest test should
 * get less playwright work, and that only balances if both kinds share a weight
 * list. Each test carries `kind` and the emitted matrix has a selector per kind.
 *
 * SELECTION IS BY TITLE, ESCAPED. See test-inventory.mjs for why -- briefly: a
 * stale file:line matches nothing and exits 0, and an unescaped regex metacharacter
 * does the same (59/170 playwright titles and 25/47 cluster titles contain one).
 *
 * COMPLETENESS IS ASSERTED, not assumed. Per-test sharding can silently drop a
 * test in ways file-level sharding could not, so this fails rather than emitting a
 * plan whose selections do not cover the inventory exactly once.
 *
 * Usage:
 *   node test/e2e/support/shard-tests.mjs <N>
 *   SHARDS=<N> PRIOR_REPORT=prev/report.json node test/e2e/support/shard-tests.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { combinedInventory, verify, escapeForGrep } from "./test-inventory.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(HERE, "..");
const WEIGHTS_PATH = join(E2E_DIR, "test-weights.json");

const DEFAULT_WEIGHT = 30; // seconds — a middling test.

/** A stable key for a test across runs: "<kind> <file basename> <title>".
 *  Basename, not full path, so the key survives a checkout at a different prefix
 *  (CI runs under /home/runner, dev machines do not). */
export function testKey(t) {
  return `${t.kind} ${basename(t.file)} ${t.title}`;
}

/** Committed fallback weights, keyed by testKey. Missing/unparseable → {}. */
function committedWeights() {
  if (!existsSync(WEIGHTS_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(WEIGHTS_PATH, "utf8"));
    delete raw._comment;
    return raw;
  } catch {
    return {};
  }
}

/** Per-TEST durations (seconds) from a prior playwright JSON report.
 *  Keyed the same way as the weights file so the two are interchangeable. */
function priorReportWeights(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return {};
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return {};
  }
  const out = {};
  const walk = (node, file) => {
    if (!node || typeof node !== "object") return;
    const f = node.file ?? file;
    for (const spec of node.specs ?? []) {
      const ms = (spec.tests ?? [])
        .flatMap((t) => t.results ?? [])
        .reduce((a, r) => a + (Number(r.duration) || 0), 0);
      if (ms > 0) out[`e2e ${basename(spec.file ?? f)} ${spec.title}`] = ms / 1000;
    }
    for (const child of node.suites ?? []) walk(child, f);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file);
  return out;
}

/** LPT greedy: heaviest test first, onto the currently-lightest shard. */
export function packTests(tests, weights, n) {
  const shards = Array.from({ length: n }, () => ({ tests: [], total: 0 }));
  const heaviest = [...tests].sort((a, b) => {
    const d =
      (weights[testKey(b)] ?? DEFAULT_WEIGHT) - (weights[testKey(a)] ?? DEFAULT_WEIGHT);
    // Tie-break on the key so the plan is deterministic for identical inputs.
    return d !== 0 ? d : testKey(a).localeCompare(testKey(b));
  });
  for (const t of heaviest) {
    let lightest = 0;
    for (let i = 1; i < n; i++) if (shards[i].total < shards[lightest].total) lightest = i;
    shards[lightest].tests.push(t);
    shards[lightest].total += weights[testKey(t)] ?? DEFAULT_WEIGHT;
  }
  return shards;
}

/** THE COVERAGE ASSERTION. Every inventory test must appear in exactly one shard.
 *  Throws with the specific tests at fault rather than emitting a lossy plan. */
export function assertCoverage(inventoryTests, shards) {
  const seen = new Map();
  for (const [i, s] of shards.entries()) {
    for (const t of s.tests) {
      const k = testKey(t);
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push(i + 1);
    }
  }
  const missing = inventoryTests.filter((t) => !seen.has(testKey(t)));
  const duplicated = [...seen.entries()].filter(([, where]) => where.length > 1);

  if (missing.length || duplicated.length) {
    const lines = [];
    if (missing.length) {
      lines.push(`${missing.length} test(s) assigned to NO shard:`);
      for (const t of missing.slice(0, 10)) {
        lines.push(`  - [${t.kind}] ${basename(t.file)} :: ${t.title}`);
      }
    }
    if (duplicated.length) {
      lines.push(`${duplicated.length} test(s) assigned to MORE THAN ONE shard:`);
      for (const [k, where] of duplicated.slice(0, 10)) {
        lines.push(`  - shards ${where.join(",")} :: ${k}`);
      }
    }
    throw new Error(`coverage assertion failed\n${lines.join("\n")}`);
  }
  return { covered: seen.size };
}

/** Build the per-shard selector strings. Playwright takes --grep, vitest takes -t;
 *  both are regexes, so titles are escaped and joined with |.
 *
 *  An EMPTY string means "this shard has no tests of that kind" -- the workflow
 *  must skip the step rather than run it with an empty pattern, which would match
 *  EVERYTHING. */
export function selectorsFor(shardTests) {
  const grepFor = (kind) => {
    const titles = shardTests
      .filter((t) => t.kind === kind)
      .map((t) => escapeForGrep(t.title));
    return titles.length ? titles.join("|") : "";
  };
  return { e2e_grep: grepFor("e2e"), cluster_grep: grepFor("cluster") };
}

function main() {
  const n = Math.max(1, Number(process.argv[2] ?? process.env.SHARDS ?? 4));

  // Refuse to plan against a suite that cannot be addressed by title.
  const all = combinedInventory();
  const v = verify(all);
  if (!v.ok) {
    process.stderr.write(
      `[shard-tests] inventory is not shardable:\n${v.problems.map((p) => `  - ${p}`).join("\n")}\n`,
    );
    process.exit(1);
  }

  const prior = priorReportWeights(process.env.PRIOR_REPORT);
  const committed = committedWeights();
  const weights = {};
  for (const t of all) {
    const k = testKey(t);
    weights[k] = prior[k] ?? committed[k] ?? DEFAULT_WEIGHT;
  }
  const source = Object.keys(prior).length
    ? "prior-report"
    : Object.keys(committed).length
      ? "committed"
      : "flat-default";

  const effN = Math.min(n, all.length) || 1;
  const shards = packTests(all, weights, effN);
  assertCoverage(all, shards);

  const include = shards.map((s, i) => {
    const sel = selectorsFor(s.tests);
    return {
      shard: i + 1,
      ...sel,
      e2e_count: s.tests.filter((t) => t.kind === "e2e").length,
      cluster_count: s.tests.filter((t) => t.kind === "cluster").length,
      est_seconds: Math.round(s.total),
    };
  });

  const totals = include.map((s) => s.est_seconds);
  process.stderr.write(
    `[shard-tests] ${all.length} tests → ${include.length} shards (weights: ${source})\n` +
      `[shard-tests] spread: min ${Math.min(...totals)}s  max ${Math.max(...totals)}s\n` +
      include
        .map(
          (s) =>
            `  shard ${s.shard}: ~${s.est_seconds}s — ${s.e2e_count} e2e + ${s.cluster_count} cluster`,
        )
        .join("\n") +
      "\n",
  );

  process.stdout.write(JSON.stringify({ include }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
