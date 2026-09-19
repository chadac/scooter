#!/usr/bin/env node
// flake-focus-report.mjs — turn a Playwright JSON report from a `flake focus` CI
// run into the markdown verdict comment posted on the PR (see the `flake-focus`
// / `flake-focus-full` jobs in .github/workflows/ci.yml).
//
// The job answers ONE question — "is the flake this PR claims to fix actually
// fixed?" — and the exit status alone cannot answer it:
//
//   * In the CONTENTION path (`flake-specs:`) the job runs whole spec FILES, so a
//     red run may be some OTHER test failing and a green run may never have
//     executed the flaky test at all (a `flake-test:` pattern matching nothing
//     still exits 0). Both read as a verdict on the flake; neither is one.
//   * A green run says "no reproduction in N attempts", which is weaker than
//     "fixed" and weaker still on the fast target (no sandbox pods -> none of the
//     cold-boot/contention machinery the nightly full-target flakes live in).
//
// So we resolve the `flake-test:` pattern against the report, count the
// repetitions of THAT test, and state the verdict — including `not-run`, which
// the caller turns into a job failure so a check that ran nothing cannot pass.
//
// Usage:
//   node scripts/flake-focus-report.mjs <report.json> --pattern <p> [options]
//     --pattern <p>     the PR's `flake-test:` line (a playwright -g pattern)
//     --target fast|full
//     --mode targeted|contention
//     --specs "<a> <b>" the `flake-specs:` files, when mode=contention
//     --run-url <url>   link back to the workflow run (artifacts/traces)
//     --suggest-full    add the "this was a full-target flake?" nudge on green
//     --baseline <f>    the CONTROL run's report: the same test, same budget, on
//                       the PR's base commit (see compareToBaseline)
//     --baseline-ref <r> how to name that base in the comment, e.g. `main@abc1234`
//
// Output: this target's SECTION of the shared flake-focus comment on stdout
// (scripts/comment-sections.mjs merges it in). When
// $GITHUB_OUTPUT is set it also writes `verdict`/`runs`/`failed`/`matched` and
// `control`/`base_runs`/`base_failed` there — the job gates on `verdict`.

import { readFileSync, appendFileSync } from "node:fs";

/**
 * Playwright's `-g` takes a REGEX, not a literal, and matches it
 * case-insensitively. Mirror that so this report agrees with what the run
 * actually selected. A malformed pattern falls back to a literal substring
 * match: reporting "matched nothing" for a regex typo would send someone
 * hunting a phantom missing test.
 */
export function patternToRegExp(pattern) {
  const delimited = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  try {
    return delimited
      ? new RegExp(delimited[1], delimited[2].includes("i") ? delimited[2] : delimited[2] + "i")
      : new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

const FAILED = new Set(["failed", "timedOut", "interrupted"]);

/**
 * Flatten the report's nested suites into one record per test TITLE.
 *
 * --repeat-each=N does not nest N results under one spec: it emits N sibling
 * `specs` entries with the SAME title (one per repetition). Aggregating by title
 * is what turns that back into "ran 20×, failed 3" — reporting each entry
 * separately would print twenty identical 1-run rows and no verdict.
 */
export function collectSpecs(report) {
  const byTitle = new Map();
  const walk = (suite, titles, file) => {
    const path = suite.title ? [...titles, suite.title] : titles;
    const f = suite.file || file;
    for (const spec of suite.specs || []) {
      const fullTitle = [...path, spec.title || ""].filter(Boolean).join(" › ");
      // Count RESULTS, not tests: with retries enabled one repetition can carry
      // several, and each is a run of the test.
      const runs = (spec.tests || [])
        .flatMap((t) => t.results || [])
        .filter((r) => r.status !== "skipped");
      const rec = byTitle.get(fullTitle) ?? {
        file: spec.file || f || "",
        title: spec.title || "",
        fullTitle,
        runs: 0,
        passed: 0,
        failed: 0,
        errors: [],
      };
      rec.runs += runs.length;
      rec.passed += runs.filter((r) => r.status === "passed").length;
      for (const r of runs.filter((r) => FAILED.has(r.status))) {
        rec.failed += 1;
        rec.errors.push(errorText(r));
      }
      byTitle.set(fullTitle, rec);
    }
    for (const child of suite.suites || []) walk(child, path, f);
  };
  for (const suite of report.suites || []) walk(suite, [], suite.file);
  return [...byTitle.values()];
}

function errorText(result) {
  const raw =
    result.error?.message ||
    (result.errors || []).map((e) => e.message).find(Boolean) ||
    `(${result.status} with no error message)`;
  // Strip ANSI so the excerpt renders in a GitHub code fence.
  const clean = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const head = clean.split("\n").slice(0, 4).join("\n");
  return head.length > 600 ? head.slice(0, 600) + "…" : head;
}

/**
 * Resolve the pattern against the report.
 *
 * verdict:
 *   not-run    — the pattern matched no executed test. The check proves NOTHING;
 *                the caller fails the job on this.
 *   reproduced — the targeted test failed at least one repetition.
 *   fixed      — every repetition of the targeted test passed. (Named for what a
 *                reader wants to know; the prose is careful to say "did not
 *                reproduce in N attempts".)
 */
export function summarize(report, pattern) {
  const re = patternToRegExp(pattern);
  const specs = collectSpecs(report);
  const matched = specs.filter((s) => re.test(s.fullTitle) || re.test(s.title));
  const executed = matched.filter((s) => s.runs > 0);
  const runs = executed.reduce((n, s) => n + s.runs, 0);
  const failed = executed.reduce((n, s) => n + s.failed, 0);
  return {
    pattern,
    matched: executed,
    // A pattern can match a test that exists but was entirely skipped — same
    // outcome for our purposes (nothing was proven), so keep it visible.
    matchedButSkipped: matched.filter((s) => s.runs === 0).length,
    executedSpecs: specs.filter((s) => s.runs > 0).length,
    // Failures of OTHER tests: in contention mode they fail the job without
    // saying anything about the flake, so they get their own section.
    others: specs.filter((s) => !matched.includes(s) && s.failed > 0),
    runs,
    failed,
    verdict: runs === 0 ? "not-run" : failed > 0 ? "reproduced" : "fixed",
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The CONTROL: the same test, same repetition budget, on the PR's base commit.
 *
 * Without it "0 failures in 20 runs" is unfalsifiable — a test that fires once
 * in 200 runs produces exactly that result on a branch that fixed nothing. The
 * control tells us whether the experiment could have detected the flake at all:
 *
 *   strong       — it fired on the base and not here. The budget was adequate and
 *                  the behaviour changed.
 *   inconclusive — it fired on NEITHER. The run says nothing about the fix; the
 *                  flake is just rarer than the budget. (Reported loudly, but not
 *                  a failure: the fix may well be right, and demanding a
 *                  reproduction would block correct fixes for rare flakes.)
 *   worse        — it failed MORE here than on the base. Not proof of a
 *                  regression at these sample sizes, but never call that "fixed".
 *   none         — no usable control (the pattern matches nothing on the base —
 *                  a renamed test — or the control run produced no report).
 */
export function compareToBaseline(summary, baseline) {
  if (!baseline || baseline.runs === 0) return { kind: "none" };
  const baseRate = baseline.failed / baseline.runs;
  // P(zero failures in `summary.runs` draws) if this branch still flaked at the
  // base's observed rate. Assumes independent runs — repetitions share a worker
  // and a server, so treat it as an order of magnitude, not a p-value.
  const pAllCleanAtBaseRate = (1 - baseRate) ** summary.runs;
  return {
    kind:
      baseline.failed === 0
        ? "inconclusive"
        : summary.failed > baseline.failed
          ? "worse"
          : summary.failed === 0
            ? "strong"
            : "weak",
    baseRuns: baseline.runs,
    baseFailed: baseline.failed,
    baseRate,
    pAllCleanAtBaseRate,
    // Did the base fire OFTEN enough that a clean run here means something? A base
    // that failed 2/20 leaves a ~12% chance of 20 clean runs by luck alone — a
    // control that weak must not be reported as "the behaviour changed", or the
    // comment overclaims in exactly the way this whole job exists to prevent.
    strength: pAllCleanAtBaseRate <= 0.05 ? "tight" : "loose",
  };
}

const pct = (x) =>
  x >= 0.01 ? `${(x * 100).toFixed(0)}%` : x >= 0.0001 ? `${(x * 100).toFixed(2)}%` : "<0.01%";

export function renderMarkdown(summary, opts = {}) {
  const {
    target = "fast",
    mode = "targeted",
    specs = "",
    runUrl = "",
    suggestFull = false,
    baseline = null,
    baselineRef = "",
  } = opts;
  const targetLabel = target === "full" ? "full target — real k3d cluster" : "fast target — fake stack";
  const control = compareToBaseline(summary, baseline);
  const baseRefLabel = baselineRef ? ` (\`${baselineRef}\`)` : "";
  // No marker here: this body is one SECTION of the shared flake-focus comment,
  // identified by the tags scripts/comment-sections.mjs wraps around it.
  const L = [];

  if (summary.verdict === "not-run") {
    L.push(`### ⚠️ flake focus (${target}) — the targeted test never ran`, "");
    L.push(
      `\`flake-test: ${summary.pattern}\` matched **no executed test**, so this check proves nothing about the flake — it passed by running ${summary.matchedButSkipped > 0 ? "only skipped tests" : "other tests"}.`,
      "",
    );
    // "distinct": repetitions are aggregated by title, so 6 tests ×5 is 6 here.
    L.push(
      `- Distinct tests executed in this run: **${summary.executedSpecs}**, none matching the pattern.`,
    );
    if (summary.matchedButSkipped > 0)
      L.push(`- ${plural(summary.matchedButSkipped, "matching test")} was skipped (target gating? \`test.skip\`?).`);
    L.push(
      `- The pattern is a case-insensitive regex matched against \`file › describe › test\`. Fix the \`flake-test:\` line in the PR description so it names a real title.`,
    );
    if (mode === "contention")
      L.push(
        `- This was a contention run over \`${specs}\` — the flaky test must live in one of those files, or it never runs here.`,
      );
  } else if (summary.verdict === "reproduced") {
    L.push(
      `### ❌ flake focus (${target}) — the flake STILL reproduces`,
      "",
      `\`${summary.pattern}\` failed **${summary.failed} of ${plural(summary.runs, "repetition")}**.`,
      "",
    );
  } else if (control.kind === "inconclusive") {
    // Green run, but the control proves the run could not have detected the
    // flake — lead with that rather than a ✅ someone will read as "fixed".
    L.push(
      `### ⚠️ flake focus (${target}) — clean, but the control did not reproduce either`,
      "",
      `\`${summary.pattern}\` passed **${summary.runs}/${summary.runs}** here — and also passed ${control.baseRuns}/${control.baseRuns} on the base${baseRefLabel}. The flake never fired in this experiment at all, so a clean run is not evidence the fix works.`,
      "",
    );
  } else if (control.kind === "strong") {
    L.push(
      control.strength === "tight"
        ? `### ✅ flake focus (${target}) — fixed: it fires on the base, not here`
        : `### ✅ flake focus (${target}) — clean here, but the control is weak (${control.baseFailed}/${control.baseRuns} on the base)`,
      "",
      `\`${summary.pattern}\` failed **${control.baseFailed}/${control.baseRuns}** on the base${baseRefLabel} and **0/${summary.runs}** on this PR.`,
      "",
    );
  } else {
    L.push(
      `### ✅ flake focus (${target}) — no reproduction in ${plural(summary.runs, "repetition")}`,
      "",
      `\`${summary.pattern}\` passed **${summary.runs}/${summary.runs}**.`,
      "",
    );
  }

  if (summary.matched.length) {
    L.push("", "| targeted test | runs | passed | failed |", "|---|---:|---:|---:|");
    for (const s of summary.matched)
      L.push(`| \`${s.fullTitle}\` | ${s.runs} | ${s.passed} | ${s.failed} |`);
  }

  if (summary.verdict !== "not-run" && control.kind !== "none") {
    L.push(
      "",
      `#### Control — the same test on the base${baseRefLabel}`,
      "",
      "| | repetitions | failures |",
      "|---|---:|---:|",
      `| base${baseRefLabel} | ${control.baseRuns} | ${control.baseFailed} |`,
      `| this PR | ${summary.runs} | ${summary.failed} |`,
      "",
    );
    if (control.kind === "strong")
      L.push(
        control.strength === "tight"
          ? `The flake fires on the base at **${pct(control.baseRate)}** and not at all here. If this branch still flaked at that rate, ${plural(summary.runs, "clean run")} in a row would happen only about **${pct(control.pAllCleanAtBaseRate)}** of the time — so this is a real change in behaviour, bounded rather than proven.`
          : `⚠️ **The control is too weak to conclude much.** The base only failed ${control.baseFailed}/${control.baseRuns} (**${pct(control.baseRate)}**), so even if this branch still flaked at exactly that rate, ${plural(summary.runs, "clean run")} in a row would happen about **${pct(control.pAllCleanAtBaseRate)}** of the time — luck explains this result almost as well as a fix does. Raise the repetition budget until the base fails often enough to make a clean run here meaningful.`,
      );
    else if (control.kind === "inconclusive")
      L.push(
        `**The experiment had no power.** The flake did not fire on the base either, so this run cannot distinguish "fixed" from "did not happen to fire". Raise the repetition budget, add \`flake-specs:\` so it runs under contention, or — if it was seen on the nightly \`e2e-full\` — use the \`e2e-full-flake-check\` label, since the fast stack cannot produce those conditions at all.`,
      );
    else if (control.kind === "worse")
      L.push(
        `⚠️ It failed **more** here than on the base. At these sample sizes that is not proof of a regression, but this PR has not fixed the flake.`,
      );
    else
      L.push(
        `It still fails here, though less often than on the base — a rate change, not a fix.`,
      );
  } else if (summary.verdict === "fixed" && baseline) {
    // A control was attempted and yielded nothing to compare against.
    L.push(
      "",
      `#### Control — none`,
      "",
      `The same pattern matched no test that ran on the base${baseRefLabel} (renamed in this PR? added by it?), so there is no baseline rate to compare against and the clean run above stands alone.`,
    );
  }

  const failing = summary.matched.filter((s) => s.errors.length);
  if (failing.length) {
    L.push("", "<details><summary>Failure output</summary>", "");
    for (const s of failing) {
      L.push(`**\`${s.fullTitle}\`** — ${plural(s.errors.length, "failed repetition")}`, "", "```");
      // One excerpt per distinct error: 20 repetitions of the same timeout add
      // nothing, and a DIFFERENT error hiding among them is the thing worth seeing.
      for (const e of [...new Set(s.errors)].slice(0, 3)) L.push(e, "");
      L.push("```", "");
    }
    L.push("</details>");
  }

  if (summary.others.length) {
    L.push(
      "",
      `<details><summary>⚠️ ${plural(summary.others.length, "other test")} also failed — not the targeted flake</summary>`,
      "",
    );
    for (const s of summary.others.slice(0, 20))
      L.push(`- \`${s.fullTitle}\` — ${plural(s.failed, "failure")}`);
    L.push("", "</details>");
  }

  L.push("", "<sub>");
  L.push(
    `Mode: **${mode === "contention" ? `contention (\`${specs}\`)` : "targeted (`-g`)"}** · ${targetLabel}${runUrl ? ` · [run log & traces](${runUrl})` : ""}`,
  );
  if (summary.verdict === "fixed") {
    L.push(
      `<br>“No reproduction in ${plural(summary.runs, "run")}” is not proof of a fix — it bounds how often the flake can still fire.`,
    );
    if (suggestFull)
      L.push(
        `<br>⚠️ This ran the FAST target, which has no sandbox pods — no cold boots, no node CPU saturation, no provisioning contention, i.e. none of the machinery most nightly \`e2e-full\` flakes live in. If the flake was seen there, a green run here shows no <em>regression</em>; add the <code>e2e-full-flake-check</code> label for evidence it is fixed.`,
      );
  }
  L.push("</sub>", "");
  return L.join("\n");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--suggest-full") out.suggestFull = true;
    else if (a.startsWith("--")) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const file = args._[0];
  const pattern = args.pattern || "";
  if (!file || !pattern) {
    console.error("usage: flake-focus-report.mjs <report.json> --pattern <p> [--target fast|full] …");
    process.exit(2);
  }

  let summary;
  try {
    summary = summarize(JSON.parse(readFileSync(file, "utf8")), pattern);
  } catch (err) {
    // No/!readable report = the run died before writing one (crash, cancel, OOM).
    // Say so plainly rather than rendering a verdict off missing data; the run
    // step has already failed the job, so this only has to be honest.
    const body = [
      `### ⚠️ flake focus (${args.target || "fast"}) — no report to summarise`,
      "",
      `The run produced no readable Playwright JSON report (\`${err.message}\`), so whether \`${pattern}\` reproduced is unknown. See the job log${args.runUrl ? ` — [run](${args.runUrl})` : ""}.`,
      "",
    ].join("\n");
    process.stdout.write(body);
    writeOutputs({ verdict: "unknown", runs: 0, failed: 0, matched: 0 });
    return;
  }

  // The control run is optional and BEST-EFFORT: it is expected to fail tests
  // (that is the point), it may not have run at all, and its report may be
  // missing. None of that may take down the verdict for the PR's own run.
  let baseline = null;
  if (args.baseline) {
    try {
      baseline = summarize(JSON.parse(readFileSync(args.baseline, "utf8")), pattern);
    } catch {
      baseline = { runs: 0, failed: 0, matched: [] };
    }
  }

  const control = compareToBaseline(summary, baseline);
  process.stdout.write(renderMarkdown(summary, { ...args, baseline }));
  writeOutputs({
    verdict: summary.verdict,
    runs: summary.runs,
    failed: summary.failed,
    matched: summary.matched.length,
    control: control.kind,
    base_failed: control.baseFailed ?? 0,
    base_runs: control.baseRuns ?? 0,
  });
}

function writeOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
}

// Run only as a CLI, so the spec can import the pure functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
