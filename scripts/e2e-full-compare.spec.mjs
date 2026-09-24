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
    expect(body).toContain("red in 2/3 baseline runs");
  });

  it("warns that a single-run window cannot separate a regression from a flake", () => {
    const body = renderMarkdown(
      compare(report([["a", false]]), report([["a", true]])),
      {
        baselineRef: "main",
      },
    );
    expect(body).toMatch(/single/i);
    expect(body).toMatch(/flaky/i);
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
    expect(body).toContain("1 new failure");
    expect(body).toContain("main@abc1234");
    expect(body).toContain("a");
    // Still-failing is context, not the headline — it belongs behind a fold.
    expect(body).toMatch(/<details>[\s\S]*still failing/i);
  });

  it("says so plainly when nothing regressed but the suite is still red", () => {
    const body = renderMarkdown(
      compare(report([["b", false]]), report([["b", false]])),
      opts,
    );
    expect(body).toContain("no new failures");
    expect(body).not.toContain("1 new failure");
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
