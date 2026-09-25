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
//     --baseline-label <l> column header for the nth --baseline (repeatable,
//                          positional). Falls back to −N "runs ago".
//
// Output: the comment body on stdout — a per-test execution history and fail
// rate, in the vocabulary a flaky-test dashboard already uses (new / broken /
// flaky / fixed). With $GITHUB_OUTPUT set it also writes `new_failures` /
// `fixed` / `still_failing` / `trustworthy`.

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
  const runSpecs = runs.map((run) =>
    collectSpecs(run).filter((x) => x.runs > 0),
  );
  const history = new Map();
  for (const [i, specs] of runSpecs.entries()) {
    for (const s of specs) {
      const h = history.get(s.fullTitle) ?? {
        ran: 0,
        failed: 0,
        spec: s,
        // Per baseline run, oldest first: "pass" | "fail" | "absent". The ORDER
        // is the evidence — `pass pass pass fail` and `pass fail fail fail` are
        // different situations, and an aggregate rate cannot tell them apart.
        seq: Array(runSpecs.length).fill("absent"),
      };
      h.ran += 1;
      if (s.failed > 0) h.failed += 1;
      h.seq[i] = s.failed > 0 ? "fail" : "pass";
      history.set(s.fullTitle, h);
    }
  }

  // A spec's baseline CLASS over the runs that ran it. Three states, not two:
  // green (never failed), red (failed every time), flaky (in between). Only
  // green→fail and red→pass are attributable to this change — collapsing flaky
  // into either one is exactly how a verdict starts crying wolf.
  // With no baseline at all there is no class to assign — "absent from the
  // window" would be true of every spec and tell a reader nothing.
  const classOf = (h) =>
    runs.length === 0
      ? null
      : !h
        ? "absent"
        : h.failed === 0
          ? "green"
          : h.failed === h.ran
            ? "red"
            : "flaky";
  const annotate = (s) => {
    const h = history.get(s.fullTitle);
    return { ...s, history: h, baselineClass: classOf(h) };
  };

  const currentFailures = cur.filter((s) => s.failed > 0).map(annotate);
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

  const buckets = !trustworthy
    ? empty
    : {
        // Green in EVERY baseline run that ran it — the only failures a reader
        // should treat as this change's doing.
        newFailures: currentFailures.filter((s) => s.baselineClass === "green"),
        stillFailing: currentFailures.filter(
          (s) => s.baselineClass === "red" || s.baselineClass === "flaky",
        ),
        // Absent from the window entirely: new spec, renamed title, or newly
        // added to full-specs.json. Not attributable to this change either way.
        unknownToBaseline: currentFailures.filter(
          (s) => s.baselineClass === "absent",
        ),
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

  // Every spec placed in exactly one baseline→current cell, so the transition
  // table adds up and a reader can check it does. `notRunHere` is the one cell
  // that is NOT a transition: the baseline ran the spec and this run did not.
  const tally = {
    green: 0,
    red: 0,
    flaky: 0,
    greenToFail: 0,
    greenToPass: 0,
    redToFail: 0,
    redToPass: 0,
    flakyToFail: 0,
    flakyToPass: 0,
    absentToFail: 0,
    absentToPass: 0,
    notRunHere: 0,
  };
  for (const h of history.values()) {
    const cls = classOf(h);
    tally[cls] += 1;
    const here = curByTitle.get(h.spec.fullTitle);
    if (!here) tally.notRunHere += 1;
    else tally[`${cls}To${here.failed > 0 ? "Fail" : "Pass"}`] += 1;
  }
  for (const s of cur)
    if (!history.has(s.fullTitle))
      tally[`absentTo${s.failed > 0 ? "Fail" : "Pass"}`] += 1;

  // One row per test, carrying its own execution history. Trunk's vocabulary
  // (new / broken / flaky / fixed) because it is what engineers already read on
  // a flaky-test dashboard — and the history strip SHOWS the evidence instead of
  // asserting a classification: `pass pass pass fail` and `pass fail fail fail`
  // are different situations and no aggregate rate can tell them apart.
  const statusOf = (h, here) => {
    if (!here) return "not-run";
    const ran = h?.ran ?? 0;
    if (here.failed > 0)
      return ran === 0
        ? "new-test"
        : h.failed === 0
          ? "new"
          : h.failed === ran
            ? "broken"
            : "flaky";
    if (ran === 0) return "pass";
    // Passed here, but it has failed in the window: NOT a fix unless it was red
    // every single time. Anything weaker is the flake landing on its good side.
    return h.failed === ran ? "fixed" : h.failed > 0 ? "flaky-pass" : "pass";
  };
  const rows = [];
  for (const t of new Set([...history.keys(), ...curByTitle.keys()])) {
    const h = history.get(t);
    const here = curByTitle.get(t);
    const spec = here ?? h.spec;
    const seq = [
      ...(h?.seq ?? Array(runSpecs.length).fill("absent")),
      here ? (here.failed > 0 ? "fail" : "pass") : "absent",
    ];
    const ran = seq.filter((x) => x !== "absent").length;
    const failed = seq.filter((x) => x === "fail").length;
    rows.push({
      file: spec.file,
      title: spec.title,
      fullTitle: t,
      seq,
      status: statusOf(h, here),
      rate: ran ? Math.round((100 * failed) / ran) : null,
    });
  }
  // Worst first: what this change broke, then what is permanently broken, then
  // noise. A reader stops as soon as the status column stops being actionable.
  const RANK = {
    new: 0,
    "new-test": 1,
    broken: 2,
    flaky: 3,
    "not-run": 4,
    fixed: 5,
    "flaky-pass": 6,
    pass: 7,
  };
  rows.sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      b.rate - a.rate ||
      a.fullTitle.localeCompare(b.fullTitle),
  );
  const count = (...s) => rows.filter((r) => s.includes(r.status)).length;
  const statusCounts = {
    new: count("new", "new-test"),
    broken: count("broken"),
    // Both sides of the coin: a known-flaky test that happened to pass here is
    // still a flaky test, and hiding it understates the suite's instability.
    flaky: count("flaky", "flaky-pass"),
    fixed: count("fixed"),
    notRun: count("not-run"),
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
    tally,
    rows,
    statusCounts,
    runLabels: opts.runLabels ?? null,
    // The suite's own swing: how much the failure count moved between baseline
    // runs with NO change between them. A "new failure" count at or under this
    // is indistinguishable from the noise, and saying ❌ over it is the
    // cry-wolf failure mode this comment exists to end.
    noiseFloor:
      runSpecs.length > 1
        ? Math.max(
            ...runSpecs.map((s) => s.filter((x) => x.failed > 0).length),
          ) -
          Math.min(...runSpecs.map((s) => s.filter((x) => x.failed > 0).length))
        : 0,
    // Totals for the headline table. The baseline is summarised PER RUN — an
    // average and a range — because that is what this run's single count is
    // comparable to. A window aggregate ("21 specs failed at least once")
    // against one run's 11 reads as a 10-spec improvement that nobody made.
    totals: {
      baselineSpecs: history.size,
      perRunFailed: runSpecs.map(
        (specs) => specs.filter((s) => s.failed > 0).length,
      ),
      perRunSpecs: runSpecs.map((specs) => specs.length),
      currentSpecs: cur.length,
      currentPassed: cur.length - currentFailures.length,
      currentFailed: currentFailures.length,
    },
  };
}

const SYM = { pass: "✅", fail: "❌", absent: "·" };
const BADGE = {
  new: "🆕 new",
  "new-test": "🆕 new test",
  broken: "🔴 broken",
  flaky: "🌗 flaky",
  "flaky-pass": "🌗 flaky",
  fixed: "✅ fixed",
  "not-run": "· not run",
  pass: "",
};

/** Column headers for the history strip: the caller's labels when it has them
 *  (dates read best), else "runs ago" — never nothing, or the columns are
 *  unreadable in the order that matters. */
function columns(cmp) {
  const n = cmp.baselineRuns;
  const given = cmp.runLabels;
  if (given?.length === n) return [...given, "this run"];
  return [...Array.from({ length: n }, (_, i) => `−${n - i}`), "this run"];
}

/** The table. One row per test that a reader can act on: what this change broke,
 *  what is permanently broken, what is flaky, what it fixed. A known-flaky test
 *  that passed here is counted in the header and omitted here — it is not news. */
function historyTable(cmp) {
  const cols = columns(cmp);
  const shown = cmp.rows.filter(
    (r) => !["pass", "flaky-pass"].includes(r.status),
  );
  if (!shown.length) return "";
  return [
    `| test | ${cols.join(" | ")} | rate | |`,
    `|---|${cols.map(() => ":--:").join("|")}|--:|---|`,
    ...shown.map(
      (r) =>
        `| \`${r.file.replace(/^.*\//, "")}\` › ${r.title} | ${r.seq
          .map((x) => SYM[x])
          .join(" | ")} | ${r.rate}% | ${BADGE[r.status]} |`,
    ),
  ].join("\n");
}

export function renderMarkdown(cmp, opts = {}) {
  const { baselineRef, runUrl } = opts;
  const c = cmp.statusCounts;
  const parts = [];

  if (cmp.missingShards > 0) {
    parts.push(
      `### ⚠️ e2e full (k3d) — no comparison: ${cmp.shardReports}/${cmp.expectedShards} shards reported`,
      "",
      "A shard that died wrote no specs, which set difference reads as passing. Re-run failed jobs.",
    );
  } else if (!cmp.hasBaseline) {
    parts.push(
      `### ⚠️ e2e full (k3d) — ${cmp.totalSpecs} test${cmp.totalSpecs === 1 ? "" : "s"} · ${cmp.totalSpecs - cmp.currentFailures.length} passed · ${cmp.currentFailures.length} failed · no baseline`,
    );
  } else {
    // ❌ only when the attributable count clears the suite's own swing: below it,
    // this is the same ❌ the comment prints on a night when nothing changed.
    const icon =
      c.new > cmp.noiseFloor
        ? "❌"
        : c.new > 0
          ? "⚠️"
          : cmp.currentFailures.length
            ? "🌗"
            : "✅";
    parts.push(
      `### ${icon} e2e full (k3d) — ${cmp.totalSpecs} test${cmp.totalSpecs === 1 ? "" : "s"} · ${cmp.totalSpecs - cmp.currentFailures.length} passed · ${cmp.currentFailures.length} failed`,
      "",
      [
        c.new ? `🆕 **${c.new} new**` : "🆕 0 new",
        c.broken ? `🔴 ${c.broken} broken` : null,
        c.flaky ? `🌗 ${c.flaky} flaky` : null,
        c.fixed ? `✅ **${c.fixed} fixed**` : null,
        c.notRun ? `· ${c.notRun} not run` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }

  if (cmp.trustworthy) {
    const table = historyTable(cmp);
    if (table) parts.push("", table);
    // One baseline column cannot separate a regression from a flake, and the
    // noise floor is 0 in that window — so ❌ above is unearned. Say so once.
    if (cmp.baselineRuns === 1 && c.new > 0)
      parts.push("", "> ⚠️ Single baseline run — a flake reads as new here.");
  }

  parts.push(
    "",
    `<sub>Each column is one run of the full suite on the default branch, oldest first; the last is this PR. Rate is failures over the runs that ran the test.` +
      `${cmp.noiseFloor > 0 ? ` The suite's failure count swings by ±${cmp.noiseFloor} between baseline runs with no change between them.` : ""}` +
      `${runUrl ? ` · [run](${runUrl})` : ""}${cmp.hasBaseline ? ` · baseline \`${baselineRef}\`` : ""}</sub>`,
  );

  return parts.join("\n");
}

const FLAGS = [
  "baseline",
  "baseline-label",
  "baseline-ref",
  "run-url",
  "expected-shards",
];

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
  // Repeatable and POSITIONAL: the nth --baseline-label names the nth --baseline,
  // so the history columns read left to right in the order the runs happened.
  const runLabels = argv
    .map((a, i) => (a === "--baseline-label" ? argv[i + 1] : null))
    .filter(Boolean);
  const cmp = compare(current, baselines, {
    expectedShards: expected ? Number(expected) : null,
    runLabels: runLabels.length ? runLabels : null,
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
