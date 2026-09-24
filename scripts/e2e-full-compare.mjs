#!/usr/bin/env node
// e2e-full-compare.mjs — diff an `e2e full (k3d)` run against the last one on
// main, and render the verdict comment (see `e2e-full-collect` in ci.yml).
//
// The full suite is broadly flaky, not stably broken: three consecutive
// nightlies failed 13, 7 and 12 specs with only partial overlap. A raw list of
// this run's failures therefore carries almost no information — the reader
// cannot tell the spec this PR broke from the nine that have been red since
// August. What they need is the DIFF against main, which is what this prints.
//
// Usage:
//   node scripts/e2e-full-compare.mjs <report.json> [options]
//     --baseline <f>       a merged report from a recent full run on main.
//                          REPEATABLE — the baseline is a window of runs, not one
//                          (see compare() for why a single run is not enough).
//     --baseline-ref <r>   how to name the newest of them, e.g. `main@abc1234`
//     --run-url <url>      link back to this workflow run (traces/videos)
//     --expected-shards <n> how many shard reports the merge should have seen
//
// Output: the comment body on stdout. With $GITHUB_OUTPUT set it also writes
// `new_failures` / `fixed` / `still_failing` / `trustworthy`.

import { readFileSync, appendFileSync } from "node:fs";

import { collectSpecs } from "./flake-focus-report.mjs";

/**
 * Bucket this run's specs against a WINDOW of recent runs on the default branch.
 *
 * Not one baseline run — several. Two consecutive nightlies on main, with no
 * change between them beyond the tree itself, differ by ~7 specs in each
 * direction; against a single baseline every one of those reads as "new
 * failure". A verdict that cries wolf seven times a night is the disease this
 * comment is supposed to cure, so the bar is raised: a failure is NEW only if
 * every baseline run that executed that spec passed it. One green run in the
 * window is enough to say "this used to pass", and one red run is enough to say
 * "this was already flaky" — which is the claim a reader can actually act on.
 *
 * `retries: 0` is policy (playwright.config.ts) — a spec has exactly one result
 * per run, so "failed" needs no flake/retry reconciliation here.
 */
export function compare(current, baselines, opts = {}) {
  const runs = (Array.isArray(baselines) ? baselines : [baselines]).filter(
    Boolean,
  );
  const cur = collectSpecs(current).filter((s) => s.runs > 0);
  const curByTitle = new Map(cur.map((s) => [s.fullTitle, s]));

  // Per spec title, across the window: how many baseline runs ran it, and how
  // many of those it failed in.
  const history = new Map();
  for (const run of runs) {
    for (const s of collectSpecs(run).filter((x) => x.runs > 0)) {
      const h = history.get(s.fullTitle) ?? { ran: 0, failed: 0, spec: s };
      h.ran += 1;
      if (s.failed > 0) h.failed += 1;
      history.set(s.fullTitle, h);
    }
  }

  const currentFailures = cur.filter((s) => s.failed > 0);
  const hasBaseline = runs.length > 0;

  // A short shard count means some specs are absent because their runner died,
  // not because they passed. Set difference cannot tell those apart, so the
  // comparison is void rather than merely incomplete — see the spec.
  const shardReports = current?.meta?.shardReports;
  const expectedShards = opts.expectedShards ?? null;
  const missingShards =
    expectedShards != null && Number.isFinite(shardReports)
      ? Math.max(0, expectedShards - shardReports)
      : 0;
  const trustworthy = hasBaseline && missingShards === 0;

  const empty = {
    newFailures: [],
    fixed: [],
    stillFailing: [],
    unknownToBaseline: [],
  };

  const seen = (s) => history.get(s.fullTitle);
  const withHistory = (s) => ({ ...s, history: seen(s) });

  const buckets = !trustworthy
    ? empty
    : {
        // Green in EVERY baseline run that ran it — the only failures a reader
        // should treat as this change's doing.
        newFailures: currentFailures.filter(
          (s) => seen(s)?.ran > 0 && seen(s).failed === 0,
        ),
        stillFailing: currentFailures
          .filter((s) => seen(s)?.failed > 0)
          .map(withHistory),
        // Absent from the window entirely: new spec, renamed title, or newly
        // added to full-specs.json. Not attributable to this change either way.
        unknownToBaseline: currentFailures.filter((s) => !seen(s)),
        // Red in every baseline run that ran it, green here. Anything weaker is
        // just the flake landing on its good side today.
        fixed: [...history.values()]
          .filter(
            (h) =>
              h.failed === h.ran &&
              h.ran > 0 &&
              curByTitle.get(h.spec.fullTitle)?.failed === 0,
          )
          .map((h) => ({ ...h.spec, history: h })),
      };

  return {
    ...buckets,
    currentFailures,
    hasBaseline,
    baselineRuns: runs.length,
    trustworthy,
    missingShards,
    shardReports,
    expectedShards,
    totalSpecs: cur.length,
  };
}

/** A failing spec, with its rate across the baseline window when we have one —
 *  "red in 4/5" and "red in 1/5" are different problems and want different owners. */
const bullet = (s) =>
  `- \`${s.file.replace(/^.*\//, "")}\` › ${s.title}` +
  (s.history?.ran > 1
    ? ` — red in ${s.history.failed}/${s.history.ran} baseline runs`
    : "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function fold(summary, specs) {
  return `<details><summary>${summary}</summary>\n\n${specs.map(bullet).join("\n")}\n\n</details>`;
}

export function renderMarkdown(cmp, opts = {}) {
  const { baselineRef, runUrl } = opts;
  const parts = [];

  if (cmp.missingShards > 0) {
    parts.push(
      `### ⚠️ e2e full (k3d) — ${plural(cmp.missingShards, "shard")} reported nothing; no comparison`,
      "",
      `Only ${cmp.shardReports} of ${cmp.expectedShards} shards wrote a report, so the specs that shard owned are missing from this run — indistinguishable from passing. Comparing against the baseline would render them as a page of green rows that nobody verified, so the diff is withheld.`,
      "",
      "Re-run the workflow (**Re-run failed jobs**); if a shard keeps dying before it reports, that is the bug to chase first.",
    );
  } else if (!cmp.hasBaseline) {
    parts.push(
      `### ⚠️ e2e full (k3d) — ${plural(cmp.currentFailures.length, "failure")}, no baseline to compare against`,
      "",
      "No previous full run on the default branch had a retained report, so this run cannot be read as a regression or a fix — only as a raw result.",
      "",
      ...(cmp.currentFailures.length
        ? [fold("failing specs", cmp.currentFailures)]
        : []),
    );
  } else if (cmp.newFailures.length > 0) {
    parts.push(
      `### ❌ e2e full (k3d) — ${plural(cmp.newFailures.length, "new failure")} vs \`${baselineRef}\``,
      "",
      `These passed in **all ${plural(cmp.baselineRuns, "baseline run")}** and fail here:`,
      "",
      cmp.newFailures.map(bullet).join("\n"),
      ...(cmp.baselineRuns === 1
        ? [
            "",
            "> ⚠️ The window is a **single** baseline run, so a spec that is merely flaky can land in this list. Two consecutive runs of this suite on `main` typically differ by several specs in each direction with no change between them at all. Widen the window before reading this as a regression.",
          ]
        : []),
    );
  } else if (cmp.currentFailures.length > 0) {
    parts.push(
      `### ✅ e2e full (k3d) — no new failures vs \`${baselineRef}\``,
      "",
      `The suite is still red (${plural(cmp.currentFailures.length, "failure")}), but every failing spec has failed before in the baseline window. Nothing here regressed.`,
    );
  } else {
    parts.push(
      `### ✅ e2e full (k3d) — all ${plural(cmp.totalSpecs, "spec")} pass`,
    );
  }

  if (cmp.trustworthy) {
    const extra = [];
    if (cmp.stillFailing.length)
      extra.push(
        fold(
          `${plural(cmp.stillFailing.length, "spec")} still failing (already red in the baseline window)`,
          cmp.stillFailing,
        ),
      );
    if (cmp.fixed.length)
      extra.push(
        fold(
          `✅ ${plural(cmp.fixed.length, "spec")} newly passing (red in every baseline run)`,
          cmp.fixed,
        ),
      );
    if (cmp.unknownToBaseline.length)
      extra.push(
        fold(
          `${plural(cmp.unknownToBaseline.length, "failing spec")} the baseline never ran (new or renamed — not attributed)`,
          cmp.unknownToBaseline,
        ),
      );
    if (extra.length) parts.push("", extra.join("\n\n"));
  }

  parts.push(
    "",
    `<sub>full target — real k3d cluster${runUrl ? ` · [run log & traces](${runUrl})` : ""}` +
      `${cmp.hasBaseline ? ` · baseline: ${plural(cmp.baselineRuns, "run")} on \`${baselineRef}\`` : ""}` +
      `<br>The full suite is flaky night to night, so a bare failure count is not a verdict — the diff against the baseline is.</sub>`,
  );

  return parts.join("\n");
}

const FLAGS = ["baseline", "baseline-ref", "run-url", "expected-shards"];

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  // The positional report path, skipping every flag AND its value.
  let reportPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (FLAGS.includes(argv[i].slice(2))) i++;
      continue;
    }
    reportPath = argv[i];
    break;
  }
  const read = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };

  const current = read(reportPath);
  if (!current) {
    process.stdout.write(
      "### ⚠️ e2e full (k3d) — no report\n\nThe merged report could not be read, so there is nothing to compare.\n",
    );
    return;
  }
  // --baseline is repeatable: the window is several recent runs, not one.
  const baselines = argv
    .map((a, i) => (a === "--baseline" ? argv[i + 1] : null))
    .filter(Boolean)
    .map(read)
    .filter(Boolean);
  const expected = opt("expected-shards");
  const cmp = compare(current, baselines, {
    expectedShards: expected ? Number(expected) : null,
  });

  process.stdout.write(
    renderMarkdown(cmp, {
      baselineRef: opt("baseline-ref"),
      runUrl: opt("run-url"),
    }) + "\n",
  );

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `new_failures=${cmp.newFailures.length}`,
        `fixed=${cmp.fixed.length}`,
        `still_failing=${cmp.stillFailing.length}`,
        `trustworthy=${cmp.trustworthy}`,
        "",
      ].join("\n"),
    );
  }
}

// Run only as a CLI, so the spec can import the pure functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2));
