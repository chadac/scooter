#!/usr/bin/env node
/**
 * The TEST INVENTORY: every individual test in the suite, with a selector that
 * addresses it unambiguously.
 *
 * This exists because per-test sharding can LOSE TESTS SILENTLY, which
 * file-level sharding could not. Three ways, all verified against the real
 * suite before this was written:
 *
 *   1. A stale `file:line` selector matches nothing and playwright EXITS 0.
 *      `playwright test --list test/e2e/multi-turn-integrity.spec.ts:999`
 *      -> "Total: 0 tests in 0 files", exit 0. Edit a spec, shift a line, and a
 *      test vanishes from CI with a green build. This is why selection is by
 *      TITLE, not by line.
 *
 *   2. An unescaped regex metacharacter in a --grep title matches nothing, and
 *      also exits 0. 59 of 170 titles contain one of . * + ? ^ $ { } ( ) | [ ] \
 *      -- e.g. "tool cards + transcript SURVIVE a reload" matched 0 tests raw
 *      and 1 test escaped. This is why titles are escaped, not interpolated.
 *
 *   3. Two tests sharing a title make one shard's --grep pull both, so the other
 *      shard's selection is wrong. The suite has 170 distinct titles today, but
 *      that is an accident rather than a rule, so `verify` enforces it.
 *
 * GROUND TRUTH is `playwright test --list --reporter=json`, not a regex over
 * source. Playwright resolves projects, testMatch and testIgnore; a regex does
 * not, and would drift from what actually runs.
 *
 * BOTH RUNNERS behave the same way, verified separately:
 *   playwright  --grep <regex>   no match -> 0 tests, exit 0   59/170 titles have metachars
 *   vitest      -t <regex>       no match -> all skipped, exit 0   25/47 titles have metachars
 * so one escaping rule and one completeness check covers both.
 *
 * ONE VITEST QUIRK worth not rediscovering: `vitest list --json` reports `name` as
 * the full "suite > test" path, but `-t` does NOT match against that string -- the
 * full name selects 0. The LEAF title alone, escaped, selects exactly 1. So the
 * cluster inventory keeps both: `name` for diagnostics, `title` (the leaf) for
 * selection.
 *
 * Usage:
 *   node test/e2e/support/test-inventory.mjs list      # JSON inventory to stdout
 *   node test/e2e/support/test-inventory.mjs verify    # uniqueness + selector round-trip
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

/** Escape every regex metacharacter so a title is matched LITERALLY by --grep.
 *  Playwright's --grep is a JS regex; an unescaped "(" or "+" silently matches
 *  nothing (see the header). */
export function escapeForGrep(title) {
  return title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every test playwright would run for `project`, as
 *  { file, line, title, fullTitle, project }.
 *
 *  --list is authoritative. It is also slow-ish (it loads every spec), so
 *  callers should do it ONCE and pass the result around. */
export function inventory({ project } = {}) {
  const args = ["test", "--list", "--reporter=json"];
  if (project) args.push("--project", project);
  const raw = execFileSync(join(REPO_ROOT, "node_modules", ".bin", "playwright"), args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    // E2E_TARGET gates whether the `full` project is defined at all -- see
    // playwright.config.ts. Asking for a project the config did not define
    // yields an empty list rather than an error.
    env: project ? { ...process.env, E2E_TARGET: project } : process.env,
    // --list writes the JSON to stdout; warnings go to stderr and are noise here.
    stdio: ["ignore", "pipe", "ignore"],
  });
  const report = JSON.parse(raw);

  const out = [];
  const walk = (node, file, titlePath) => {
    if (!node || typeof node !== "object") return;
    const f = node.file ?? file;
    const path = node.title ? [...titlePath, node.title] : titlePath;
    for (const spec of node.specs ?? []) {
      out.push({
        file: spec.file ?? f,
        line: spec.line,
        title: spec.title,
        // The " › "-joined path playwright prints. Kept for diagnostics only --
        // selection uses `title`, which is what --grep matches against.
        fullTitle: [...path, spec.title].join(" › "),
        project: (spec.tests ?? [])[0]?.projectName ?? null,
      });
    }
    for (const child of node.suites ?? []) walk(child, f, path);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file, []);
  return out;
}

/** Every CLUSTER (vitest) test, as { file, title, name, kind }.
 *
 *  RUN_CLUSTER_TESTS=1 is required: these specs self-skip without it, and a
 *  listing with it unset comes back EMPTY rather than erroring.
 *
 *  `title` is the LEAF, not `name`. vitest's -t does not match the full
 *  "suite > test" path that list reports -- passing the whole thing selects 0.
 *  Verified: the leaf "…assigned a hostPod + hostIP", escaped, selects 1; the
 *  full name selects 0. */
/** The cluster spec files the e2e-full shards are responsible for.
 *
 *  ONLY THE SMOKE PAIR. test/cluster holds 47 tests across 15 files, but the
 *  shards only ever ran these two -- the workflow passed them to vitest as
 *  positional filters. The rest belong to `cluster image boot`, a SEPARATE job
 *  with its own cluster (sandbox-os, overlay-store, scooter-converge,
 *  scooterRebuildTwice, warm-store) and to suites nothing schedules per-shard.
 *
 *  Distributing all 47 was a scoping mistake, and it is not a quiet one: a
 *  shard assigned a warmpool or self-modify test loads that file and runs
 *  infrastructure work its cluster was never prepared for. Observed as 8 failed
 *  test FILES in a shard that had been assigned 11 cluster tests.
 *
 *  Adding a file here means the shards start running it, so it is a deliberate
 *  list rather than a glob. */
export const SHARDED_CLUSTER_SPECS = ["platform-smoke", "event-backfill"];

export function clusterInventory() {
  const raw = execFileSync(join(REPO_ROOT, "node_modules", ".bin", "vitest"), ["list", "--project", "cluster", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    env: { ...process.env, RUN_CLUSTER_TESTS: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(raw)
    // Keep only the smoke pair -- see SHARDED_CLUSTER_SPECS.
    .filter((t) => SHARDED_CLUSTER_SPECS.some((s) => (t.file ?? "").includes(s)))
    .map((t) => ({
      file: t.file,
      name: t.name,
      title: t.name.split(" > ").pop(),
      kind: "cluster",
    }));
}

/** The combined pool: playwright + cluster tests, each tagged with `kind` so the
 *  packer can emit the right selector for each. ONE pool on purpose -- a shard
 *  carrying platform-smoke's slowest test should get less playwright work, and
 *  that only balances if both kinds share a weight list. */
export function combinedInventory() {
  return [
    // --project=full, NOT an unfiltered --list. The `full` project carries
    // `testMatch: fullSpecs` (playwright.config.ts), so only the 26 files in
    // full-specs.json run there -- 124 tests, where an unfiltered list reports
    // 170 across 37 files.
    //
    // Distributing all 170 put 46 tests into selectors that the full project
    // will never match, so those tests ran NOWHERE while the planner's coverage
    // assertion still passed -- it was checking its own arithmetic against the
    // wrong universe. Observed as a shard planned for 42 tests running 31.
    //
    // E2E_TARGET=full is what makes the project exist at all; without it the
    // config omits it and the list comes back empty.
    ...inventory({ project: "full" }).map((t) => ({ ...t, kind: "e2e" })),
    ...clusterInventory(),
  ];
}

/** Fail loudly on anything that would make title selection lose a test.
 *  Returns { ok, tests, problems[] }. */
export function verify(tests = inventory()) {
  const problems = [];

  // 1. DUPLICATE TITLES. Two tests with one title means a --grep (or -t) for
  //    either selects both, so whichever shard did not ask for it runs it anyway
  //    and the shard that did may double-count. Enforced rather than assumed.
  //
  //    Scoped PER KIND, not globally: a playwright --grep only ever searches
  //    playwright tests and a vitest -t only ever searches cluster tests, so an
  //    e2e title colliding with a cluster title is harmless. Checking globally
  //    would reject a safe suite.
  const byTitle = new Map();
  for (const t of tests) {
    const key = `${t.kind ?? "e2e"}\u0000${t.title}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(t);
  }
  for (const [key, group] of byTitle) {
    if (group.length > 1) {
      const [kind, title] = key.split("\u0000");
      problems.push(
        `duplicate ${kind} title (${group.length}x): ${JSON.stringify(title)}\n` +
          group.map((g) => `      ${g.file}${g.line ? `:${g.line}` : ""}`).join("\n"),
      );
    }
  }

  // 2. EMPTY OR WHITESPACE TITLES cannot be selected at all.
  for (const t of tests) {
    if (!t.title || !t.title.trim()) {
      problems.push(`empty title at ${t.file}${t.line ? `:${t.line}` : ""}`);
    }
  }

  // 3. THE ESCAPED TITLE MUST MATCH THE ORIGINAL. This is the check that would
  //    have caught the metacharacter trap: 59 of 170 playwright titles and 25 of
  //    47 cluster titles contain a regex metacharacter, and an unescaped one
  //    matches NOTHING while exiting 0. Compiling the escaped form and testing it
  //    against the source string proves the selector we will emit actually
  //    selects this test.
  for (const t of tests) {
    if (!t.title) continue;
    let re;
    try {
      re = new RegExp(escapeForGrep(t.title));
    } catch (e) {
      problems.push(`title does not escape to a valid regex at ${t.file}: ${e.message}`);
      continue;
    }
    if (!re.test(t.title)) {
      problems.push(`escaped title does not match itself at ${t.file}: ${JSON.stringify(t.title)}`);
    }
  }

  return { ok: problems.length === 0, tests, problems };
}

function main() {
  const cmd = process.argv[2] ?? "list";
  if (cmd === "list") {
    process.stdout.write(JSON.stringify(combinedInventory(), null, 2));
    return;
  }
  if (cmd === "verify") {
    const { ok, tests, problems } = verify(combinedInventory());
    const e2e = tests.filter((t) => t.kind === "e2e").length;
    const cluster = tests.filter((t) => t.kind === "cluster").length;
    process.stderr.write(`[test-inventory] ${tests.length} tests (${e2e} e2e + ${cluster} cluster)\n`);
    if (!ok) {
      process.stderr.write(
        `[test-inventory] ${problems.length} problem(s) that would LOSE TESTS in a sharded run:\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          "\n",
      );
      process.exit(1);
    }
    process.stderr.write("[test-inventory] ok — every test is uniquely addressable by title\n");
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\nusage: test-inventory.mjs [list|verify]\n`);
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
