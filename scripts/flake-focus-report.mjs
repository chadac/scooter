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
//
// Output: the markdown comment body (incl. its sticky marker) on stdout. When
// $GITHUB_OUTPUT is set it also writes `verdict`/`runs`/`failed`/`matched` there.

import { readFileSync, appendFileSync } from "node:fs";

/** Marker the CI step greps for to update (rather than duplicate) its comment. */
export const marker = (target) => `<!-- flake-focus-report:${target} -->`;

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

export function renderMarkdown(summary, opts = {}) {
  const { target = "fast", mode = "targeted", specs = "", runUrl = "", suggestFull = false } = opts;
  const targetLabel = target === "full" ? "full target — real k3d cluster" : "fast target — fake stack";
  const L = [marker(target), ""];

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
      marker(args.target || "fast"),
      "",
      `### ⚠️ flake focus (${args.target || "fast"}) — no report to summarise`,
      "",
      `The run produced no readable Playwright JSON report (\`${err.message}\`), so whether \`${pattern}\` reproduced is unknown. See the job log${args.runUrl ? ` — [run](${args.runUrl})` : ""}.`,
      "",
    ].join("\n");
    process.stdout.write(body);
    writeOutputs({ verdict: "unknown", runs: 0, failed: 0, matched: 0 });
    return;
  }

  process.stdout.write(renderMarkdown(summary, args));
  writeOutputs({
    verdict: summary.verdict,
    runs: summary.runs,
    failed: summary.failed,
    matched: summary.matched.length,
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
