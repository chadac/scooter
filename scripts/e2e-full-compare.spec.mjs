import { describe, expect, it } from "vitest";

import { compare, renderMarkdown } from "./e2e-full-compare.mjs";

/** Build a minimal Playwright JSON report: `specs` is [title, ok] pairs. */
function report(specs, meta) {
  return {
    meta,
    suites: [
      {
        title: "",
        file: "spec.ts",
        suites: specs.map(([title, ok]) => ({
          title: "group",
          file: "spec.ts",
          specs: [
            {
              title,
              file: "spec.ts",
              tests: [
                {
                  results: [{ status: ok ? "passed" : "failed", duration: 1 }],
                },
              ],
            },
          ],
        })),
      },
    ],
  };
}

const title = (t) => `group › ${t}`;

describe("compare", () => {
  it("splits failures into NEW vs STILL-FAILING against the baseline", () => {
    const cmp = compare(
      report([
        ["a", false],
        ["b", false],
        ["c", true],
      ]),
      report([
        ["a", true],
        ["b", false],
        ["c", true],
      ]),
    );

    expect(cmp.newFailures.map((s) => s.fullTitle)).toEqual([title("a")]);
    expect(cmp.stillFailing.map((s) => s.fullTitle)).toEqual([title("b")]);
    expect(cmp.fixed).toEqual([]);
  });

  it("reports a spec that failed on the baseline and passes here as FIXED", () => {
    const cmp = compare(report([["a", true]]), report([["a", false]]));
    expect(cmp.fixed.map((s) => s.fullTitle)).toEqual([title("a")]);
    expect(cmp.newFailures).toEqual([]);
  });

  // A spec the baseline never ran cannot be attributed to this change — it may
  // be new, renamed, or newly added to the full allowlist. Calling it a
  // regression is the failure mode that makes the comment untrustworthy.
  it("does not call a failure NEW when the baseline never ran that spec", () => {
    const cmp = compare(report([["fresh", false]]), report([["a", true]]));
    expect(cmp.newFailures).toEqual([]);
    expect(cmp.unknownToBaseline.map((s) => s.fullTitle)).toEqual([
      title("fresh"),
    ]);
  });

  it("carries no verdict at all when there is no baseline", () => {
    const cmp = compare(report([["a", false]]), null);
    expect(cmp.hasBaseline).toBe(false);
    expect(cmp.newFailures).toEqual([]);
    expect(cmp.currentFailures.map((s) => s.fullTitle)).toEqual([title("a")]);
  });

  /**
   * The trap this whole comparison could walk into. A shard that dies before
   * writing its report contributes NO specs, so every spec it owned is simply
   * absent from the merged report — indistinguishable from "passed" by set
   * difference, and it would render as a page of green "fixed" rows. The merged
   * report records how many shard reports actually landed for exactly this
   * reason; a short count must void the comparison, not decorate it.
   */
  it("voids the comparison when a shard report is missing", () => {
    const cmp = compare(
      report([["a", true]], { shardReports: 3 }),
      report([
        ["a", false],
        ["b", false],
      ]),
      { expectedShards: 4 },
    );
    expect(cmp.trustworthy).toBe(false);
    expect(cmp.missingShards).toBe(1);
    expect(cmp.fixed).toEqual([]);
  });

  it("trusts the comparison when every shard reported", () => {
    const cmp = compare(
      report([["a", true]], { shardReports: 4 }),
      report([["a", false]]),
      {
        expectedShards: 4,
      },
    );
    expect(cmp.trustworthy).toBe(true);
    expect(cmp.fixed.map((s) => s.fullTitle)).toEqual([title("a")]);
  });
});

/**
 * The counts, not the names, are what a reader reads first — "did this get
 * worse" is a subtraction, and making them do it from two bulleted lists is why
 * the first version of this comment was hard to act on.
 */
describe("the per-test history table", () => {
  // Baseline: a green in all 3, b red in all 3, c flaky (red in 1 of 3), d green.
  const window3 = [
    report([
      ["a", true],
      ["b", false],
      ["c", true],
      ["d", true],
    ]),
    report([
      ["a", true],
      ["b", false],
      ["c", false],
      ["d", true],
    ]),
    report([
      ["a", true],
      ["b", false],
      ["c", true],
      ["d", true],
    ]),
  ];

  it("classifies a baseline spec as green, red or FLAKY — never just pass/fail", () => {
    const cmp = compare(
      report([
        ["a", true],
        ["b", false],
        ["c", true],
        ["d", true],
      ]),
      window3,
    );
    expect(cmp.tally.green).toBe(2); // a, d
    expect(cmp.tally.red).toBe(1); // b
    expect(cmp.tally.flaky).toBe(1); // c
  });

  it("places every spec in exactly one transition cell, so the table adds up", () => {
    const cmp = compare(
      report([
        ["a", false], // green → fail: the only attributable regression
        ["b", false], // red   → fail: still failing
        ["c", false], // flaky → fail: NOT attributable
        ["d", true], // green → pass
        ["e", false], // absent from the window
      ]),
      window3,
    );
    const t = cmp.tally;
    expect(t.greenToFail).toBe(1);
    expect(t.redToFail).toBe(1);
    expect(t.flakyToFail).toBe(1);
    expect(t.greenToPass).toBe(1);
    expect(t.absentToFail).toBe(1);
    // Every baseline spec accounted for, plus the one this run added.
    const cells =
      t.greenToFail +
      t.greenToPass +
      t.redToFail +
      t.redToPass +
      t.flakyToFail +
      t.flakyToPass +
      t.absentToFail +
      t.absentToPass +
      t.notRunHere;
    expect(cells).toBe(5);
    // The one failure a reader should chase is the green→fail one, alone.
    expect(cmp.newFailures.map((s) => s.fullTitle)).toEqual([title("a")]);
  });

  it("counts a spec the baseline ran and this run did not as NOT RUN, never as passing", () => {
    const cmp = compare(report([["a", true]]), window3);
    expect(cmp.tally.notRunHere).toBe(3); // b, c, d
    expect(cmp.tally.greenToPass).toBe(1); // a
    expect(cmp.fixed).toEqual([]); // b was red in all 3 but did not run here
  });

  it("summarises the baseline PER RUN, so this run's count is comparable to it", () => {
    const cmp = compare(
      report([
        ["a", true],
        ["b", false],
        ["c", true],
        ["d", true],
      ]),
      window3,
    );
    // Window aggregates are the trap: 2 specs failed at least once across the
    // three runs, so an aggregate column would show "2" against this run's "1"
    // and imply a fix. Per run the baseline failed 1, 2, 1 — this run's 1 is
    // squarely inside that, i.e. no change at all.
    expect(cmp.totals.perRunFailed).toEqual([1, 2, 1]);
    expect(cmp.totals.currentFailed).toBe(1);
    expect(cmp.totals.currentPassed).toBe(3);
  });

  it("will not say ❌ for a new-failure count inside the suite's own swing", () => {
    // The baseline failed 1, 2, 1 — a swing of 1 with no change between runs. So
    // one new failure here is exactly the noise, and a ❌ over it is the same ❌
    // this comment would print on a quiet night.
    const cmp = compare(
      report([
        ["a", false], // green in all 3 → fails here
        ["b", false],
        ["c", true],
        ["d", true],
      ]),
      window3,
    );
    expect(cmp.newFailures).toHaveLength(1);
    expect(cmp.noiseFloor).toBe(1);
    const body = renderMarkdown(cmp, { baselineRef: "main@abc1234" });
    expect(body).toContain("⚠️");
    expect(body).not.toContain("### ❌");
    expect(body).toContain("swings by ±1");
    // Still listed — "not separable by counting" is not "ignore it".
    expect(body).toContain("🆕 new");
  });

  it("says ❌ once the new failures outrun the swing", () => {
    const cmp = compare(
      report([
        ["a", false],
        ["b", false],
        ["c", false],
        ["d", false], // two green-in-all specs fail: 2 > swing of 1
      ]),
      window3,
    );
    expect(cmp.newFailures).toHaveLength(2);
    expect(renderMarkdown(cmp, { baselineRef: "main@abc1234" })).toContain(
      "### ❌",
    );
  });

  it("renders both tables, with the attributable rows kept even at zero", () => {
    const body = renderMarkdown(
      compare(
        report([
          ["a", true],
          ["b", false],
          ["c", true],
          ["d", true],
        ]),
        window3,
      ),
      { baselineRef: "main@abc1234" },
    );
    // One column per baseline run plus this one, oldest first.
    expect(body).toContain("| test | −3 | −2 | −1 | this run | rate | |");
    // Zero newly-failing is a claim worth printing, not a count to hide.
    expect(body).toContain("🆕 0 new");
    // b is red in every baseline run and failed here too: 100%, and "broken"
    // rather than anything that implicates this change.
    expect(body).toMatch(/❌ \| ❌ \| ❌ \| ❌ \| 100% \| 🔴 broken/);
    // c is flaky in the window and PASSED here — counted in the header, and kept
    // out of the table, because a known flake passing is not news.
    expect(body).toContain("🌗 1 flaky");
    expect(body).not.toContain("› c ");
  });
});

/**
 * The window is what keeps this comment honest. Two consecutive nightlies on
 * main differ by several specs in each direction with no change between them,
 * so a one-run baseline manufactures regressions that nobody caused.
 */
describe("compare against a window of baseline runs", () => {
  it("does not call a failure NEW when any baseline run was already red", () => {
    const cmp = compare(report([["a", false]]), [
      report([["a", true]]),
      report([["a", false]]), // flaked here — so it was never reliably green
      report([["a", true]]),
    ]);
    expect(cmp.newFailures).toEqual([]);
    expect(cmp.stillFailing.map((s) => s.fullTitle)).toEqual([title("a")]);
  });

  it("calls a failure NEW only when every baseline run passed it", () => {
    const cmp = compare(report([["a", false]]), [
      report([["a", true]]),
      report([["a", true]]),
      report([["a", true]]),
    ]);
    expect(cmp.newFailures.map((s) => s.fullTitle)).toEqual([title("a")]);
    expect(cmp.baselineRuns).toBe(3);
  });

  it("claims FIXED only when the spec was red in every baseline run", () => {
    const flaky = compare(report([["a", true]]), [
      report([["a", false]]),
      report([["a", true]]),
    ]);
    expect(flaky.fixed).toEqual([]);

    const genuine = compare(report([["a", true]]), [
      report([["a", false]]),
      report([["a", false]]),
    ]);
    expect(genuine.fixed.map((s) => s.fullTitle)).toEqual([title("a")]);
  });

  it("reports each still-failing spec's rate across the window", () => {
    const body = renderMarkdown(
      compare(report([["a", false]]), [
        report([["a", false]]),
        report([["a", true]]),
        report([["a", false]]),
      ]),
      { baselineRef: "main" },
    );
    expect(body).toContain("| ❌ | ✅ | ❌ | ❌ | 75% | 🌗 flaky |");
  });

  it("warns that a single-run window cannot separate a regression from a flake", () => {
    const body = renderMarkdown(
      compare(report([["a", false]]), report([["a", true]])),
      {
        baselineRef: "main",
      },
    );
    expect(body).toMatch(/single baseline run/i);
    expect(body).toMatch(/flake reads as new/i);
  });
});

describe("renderMarkdown", () => {
  const opts = { baselineRef: "main@abc1234", runUrl: "https://example/run/1" };

  it("leads with the new failures and names the baseline", () => {
    const body = renderMarkdown(
      compare(
        report([
          ["a", false],
          ["b", false],
        ]),
        report([
          ["a", true],
          ["b", false],
        ]),
      ),
      opts,
    );
    expect(body).toContain("🆕 **1 new**");
    expect(body).toContain("main@abc1234");
    expect(body).toContain("a");
    // The counts come before the names: a reader wants "did this get worse" in
    // one glance, which a list of spec titles cannot answer.
    // The counts come first, then the per-test evidence.
    expect(body.indexOf("🆕 **1 new**")).toBeLessThan(body.indexOf("| test |"));
    // And the new one carries its history, not just a label.
    expect(body).toMatch(/› a \| ✅ \| ❌ \| 50% \| 🆕 new \|/);
  });

  it("says so plainly when nothing regressed but the suite is still red", () => {
    const body = renderMarkdown(
      compare(report([["b", false]]), report([["b", false]])),
      opts,
    );
    expect(body).toContain("🆕 0 new");
    expect(body).toContain("🔴 1 broken");
  });

  it("states that no baseline was available rather than implying a clean diff", () => {
    const body = renderMarkdown(compare(report([["a", false]]), null), opts);
    expect(body).toMatch(/no baseline/i);
    expect(body).not.toMatch(/new failure/i);
  });

  it("warns loudly instead of reporting a diff when a shard is missing", () => {
    const body = renderMarkdown(
      compare(
        report([["a", true]], { shardReports: 3 }),
        report([["a", false]]),
        {
          expectedShards: 4,
        },
      ),
      opts,
    );
    expect(body).toMatch(/shard/i);
    expect(body).not.toMatch(/fixed/i);
  });

  it("is green and short when the suite passes", () => {
    const body = renderMarkdown(
      compare(report([["a", true]]), report([["a", true]])),
      opts,
    );
    expect(body).toContain("✅");
  });
});
