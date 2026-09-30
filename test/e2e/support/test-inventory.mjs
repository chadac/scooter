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

/** Fail loudly on anything that would make title selection lose a test.
 *  Returns { ok, tests, problems[] }. */
export function verify(tests = inventory()) {
  const problems = [];

  // 1. DUPLICATE TITLES. Two tests with one title means a --grep for either
  //    selects both, so whichever shard did not ask for it runs it anyway and
  //    the shard that did may double-count. Enforced rather than assumed.
  const byTitle = new Map();
  for (const t of tests) {
    if (!byTitle.has(t.title)) byTitle.set(t.title, []);
    byTitle.get(t.title).push(t);
  }
  for (const [title, group] of byTitle) {
    if (group.length > 1) {
      problems.push(
        `duplicate title (${group.length}x): ${JSON.stringify(title)}\n` +
          group.map((g) => `      ${g.file}:${g.line}`).join("\n"),
      );
    }
  }

  // 2. EMPTY OR WHITESPACE TITLES cannot be selected at all.
  for (const t of tests) {
    if (!t.title || !t.title.trim()) {
      problems.push(`empty title at ${t.file}:${t.line}`);
    }
  }

  return { ok: problems.length === 0, tests, problems };
}

function main() {
  const cmd = process.argv[2] ?? "list";
  if (cmd === "list") {
    process.stdout.write(JSON.stringify(inventory(), null, 2));
    return;
  }
  if (cmd === "verify") {
    const { ok, tests, problems } = verify();
    process.stderr.write(`[test-inventory] ${tests.length} tests, ${new Set(tests.map((t) => t.title)).size} distinct titles\n`);
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
