import { describe, expect, it } from "vitest";

import {
  compareToBaseline,
  marker,
  patternToRegExp,
  renderMarkdown,
  summarize,
} from "./flake-focus-report.mjs";

/**
 * A minimal Playwright JSON report, shaped like the real thing: --repeat-each=N
 * emits N SIBLING `specs` entries with the same title (verified against a real
 * `playwright test --repeat-each=3 --reporter=json` run), NOT one spec holding N
 * results — so one status per spec entry here.
 *
 *   report([["test/e2e/x.spec.ts", [["a test", ["passed", "failed"]]]]])
 */
const report = (files) => ({
  suites: files.map(([file, specs]) => ({
    title: file,
    file,
    specs: specs.flatMap(([title, statuses]) =>
      statuses.map((s) => ({
        title,
        file,
        tests: [
          {
            results: [
              { status: s, ...(s === "passed" ? {} : { error: { message: "expected 3, got 2" } }) },
            ],
          },
        ],
      })),
    ),
    suites: [],
  })),
});

const targeted = (statuses) =>
  report([["test/e2e/queue-durability.spec.ts", [["THREE messages sent mid-run", statuses]]]]);

describe("summarize", () => {
  it("reports a clean targeted run as fixed, counting every repetition", () => {
    const s = summarize(targeted(Array(20).fill("passed")), "THREE messages sent mid-run");
    expect(s.verdict).toBe("fixed");
    expect(s.runs).toBe(20);
    expect(s.failed).toBe(0);
    expect(s.matched).toHaveLength(1);
    expect(s.matched[0].fullTitle).toContain("THREE messages sent mid-run");
  });

  it("reports a single failed repetition as still reproducing", () => {
    const s = summarize(
      targeted([...Array(17).fill("passed"), "failed", ...Array(2).fill("passed")]),
      "THREE messages sent mid-run",
    );
    expect(s.verdict).toBe("reproduced");
    expect(s.failed).toBe(1);
    expect(s.runs).toBe(20);
  });

  it("counts timedOut and interrupted as failures, not as passes", () => {
    const s = summarize(targeted(["passed", "timedOut", "interrupted"]), "mid-run");
    expect(s.failed).toBe(2);
    expect(s.verdict).toBe("reproduced");
  });

  // THE case the exit-code gate exists for: in a contention run (whole spec
  // FILES, no -g) playwright exits 0 having never executed the flaky test, so
  // without this the check reads as "flake fixed" on zero evidence.
  it("reports not-run when the pattern matches nothing that executed", () => {
    const s = summarize(
      report([["test/e2e/sessions.spec.ts", [["renames a session", ["passed", "passed"]]]]]),
      "THREE messages sent mid-run",
    );
    expect(s.verdict).toBe("not-run");
    expect(s.runs).toBe(0);
    expect(s.executedSpecs).toBe(1);
  });

  it("reports not-run when the matching test existed but was skipped", () => {
    const s = summarize(targeted(["skipped", "skipped"]), "mid-run");
    expect(s.verdict).toBe("not-run");
    expect(s.matchedButSkipped).toBe(1);
  });

  it("separates other specs' failures from the targeted test's", () => {
    const s = summarize(
      report([
        ["test/e2e/queue-durability.spec.ts", [["THREE messages sent mid-run", ["passed", "passed"]]]],
        ["test/e2e/sessions.spec.ts", [["renames a session", ["failed"]]]],
      ]),
      "THREE messages sent mid-run",
    );
    expect(s.verdict).toBe("fixed");
    expect(s.others).toHaveLength(1);
    expect(s.others[0].fullTitle).toContain("renames a session");
  });

  it("matches the pattern against the full title path, like playwright -g", () => {
    const s = summarize(
      {
        suites: [
          {
            title: "test/e2e/sessions.spec.ts",
            file: "test/e2e/sessions.spec.ts",
            specs: [],
            suites: [
              {
                title: "sessions",
                file: "test/e2e/sessions.spec.ts",
                specs: [{ title: "renames a session", tests: [{ results: [{ status: "passed" }] }] }],
                suites: [],
              },
            ],
          },
        ],
      },
      "sessions › renames",
    );
    expect(s.verdict).toBe("fixed");
  });
});

describe("patternToRegExp", () => {
  it("matches case-insensitively, as playwright's -g does", () => {
    expect(patternToRegExp("three MESSAGES").test("THREE messages sent")).toBe(true);
  });

  it("honours regex syntax and /…/flags form", () => {
    expect(patternToRegExp("sent (mid|post)-run").test("THREE messages sent mid-run")).toBe(true);
    expect(patternToRegExp("/^queue/").test("queue survives")).toBe(true);
  });

  // A regex typo must not masquerade as "the test does not exist" — that sends
  // someone hunting a missing test instead of fixing their pattern.
  it("falls back to a literal match on an invalid regex", () => {
    expect(patternToRegExp("a (b").test("a (b")).toBe(true);
  });
});

describe("renderMarkdown", () => {
  const md = (statuses, opts) =>
    renderMarkdown(summarize(targeted(statuses), "THREE messages sent mid-run"), opts);

  it("carries the per-target sticky marker so CI updates one comment", () => {
    expect(md(["passed"], { target: "full" })).toContain(marker("full"));
    expect(marker("fast")).not.toBe(marker("full"));
  });

  it("names the specific test and the repetition count on green", () => {
    const body = md(Array(20).fill("passed"), { target: "fast" });
    expect(body).toContain("✅");
    expect(body).toContain("no reproduction in 20 repetitions");
    expect(body).toContain("THREE messages sent mid-run");
    expect(body).toContain("| 20 | 20 | 0 |");
  });

  it("nudges toward the full target only when asked, and only on green", () => {
    expect(md(["passed"], { target: "fast", suggestFull: true })).toContain("e2e-full-flake-check");
    expect(md(["passed"], { target: "fast" })).not.toContain("e2e-full-flake-check");
    expect(md(["failed"], { target: "fast", suggestFull: true })).not.toContain("e2e-full-flake-check");
  });

  it("shows the failure output when the flake still reproduces", () => {
    const body = md(["passed", "failed"], { target: "fast" });
    expect(body).toContain("❌");
    expect(body).toContain("STILL reproduces");
    expect(body).toContain("failed **1 of 2 repetitions**");
    expect(body).toContain("expected 3, got 2");
  });

  it("explains, on not-run, that the check proved nothing", () => {
    const body = renderMarkdown(
      summarize(report([["test/e2e/sessions.spec.ts", [["renames a session", ["passed"]]]]]), "no such test"),
      { target: "fast", mode: "contention", specs: "test/e2e/sessions.spec.ts" },
    );
    expect(body).toContain("⚠️");
    expect(body).toContain("never ran");
    expect(body).toContain("proves nothing");
    expect(body).toContain("test/e2e/sessions.spec.ts");
  });
});

describe("compareToBaseline", () => {
  const pr = (statuses) => summarize(targeted(statuses), "THREE messages sent mid-run");
  const base = (statuses) => summarize(targeted(statuses), "THREE messages sent mid-run");

  it("calls it strong when the flake fires on the base and not on the PR", () => {
    const c = compareToBaseline(pr(Array(20).fill("passed")), base([...Array(14).fill("passed"), ...Array(6).fill("failed")]));
    expect(c.kind).toBe("strong");
    expect(c.baseFailed).toBe(6);
    expect(c.baseRate).toBeCloseTo(0.3);
    // P(20 clean runs | 30% failure rate) — the bound the comment quotes.
    expect(c.pAllCleanAtBaseRate).toBeLessThan(0.001);
  });

  // The case the control exists for: a clean PR run that could never have
  // detected the flake anyway, which reads as "fixed" without this.
  it("calls it inconclusive when the base run is clean too", () => {
    const c = compareToBaseline(pr(Array(20).fill("passed")), base(Array(20).fill("passed")));
    expect(c.kind).toBe("inconclusive");
  });

  it("calls it worse when the PR fails more often than the base", () => {
    const c = compareToBaseline(pr(["failed", "failed", "passed"]), base(["failed", "passed", "passed"]));
    expect(c.kind).toBe("worse");
  });

  it("reports no control when the base ran nothing (renamed test, missing report)", () => {
    expect(compareToBaseline(pr(["passed"]), null).kind).toBe("none");
    expect(compareToBaseline(pr(["passed"]), { runs: 0, failed: 0, matched: [] }).kind).toBe("none");
  });
});

describe("renderMarkdown with a control run", () => {
  const md = (prStatuses, baseStatuses, opts = {}) =>
    renderMarkdown(summarize(targeted(prStatuses), "THREE messages sent mid-run"), {
      target: "fast",
      baseline: baseStatuses && summarize(targeted(baseStatuses), "THREE messages sent mid-run"),
      baselineRef: "main@abc1234",
      ...opts,
    });

  it("leads with the fires-on-base/clean-here headline and quotes both rates", () => {
    const body = md(Array(20).fill("passed"), [...Array(14).fill("passed"), ...Array(6).fill("failed")]);
    expect(body).toContain("✅");
    expect(body).toContain("fires on the base, not here");
    expect(body).toContain("**6/20** on the base");
    expect(body).toContain("| base (`main@abc1234`) | 20 | 6 |");
    expect(body).toContain("| this PR | 20 | 0 |");
  });

  // A clean run with a clean control must NOT read as a ✅ fix.
  it("downgrades a clean run to ⚠️ inconclusive when the control was clean", () => {
    const body = md(Array(20).fill("passed"), Array(20).fill("passed"));
    expect(body).toContain("⚠️");
    expect(body).toContain("control did not reproduce either");
    expect(body).toContain("no power");
    expect(body).not.toContain("✅");
  });

  it("says so plainly when there was no usable control", () => {
    const body = md(Array(5).fill("passed"), []);
    expect(body).toContain("Control — none");
    expect(body).toContain("matched no test that ran on the base");
  });

  it("omits the control section entirely when none was attempted", () => {
    const body = md(Array(5).fill("passed"), null);
    expect(body).not.toContain("Control");
  });
});

// A control is only evidence if the base failed often enough that a clean run
// here would be unlikely by luck. 2/20 on the base leaves ~12% — that must read
// as weak, not as "fixed".
describe("control strength", () => {
  const clean20 = summarize(targeted(Array(20).fill("passed")), "THREE messages sent mid-run");
  const baseWith = (failures) =>
    summarize(
      targeted([...Array(20 - failures).fill("passed"), ...Array(failures).fill("failed")]),
      "THREE messages sent mid-run",
    );

  it("calls a 2/20 base loose and a 6/20 base tight", () => {
    expect(compareToBaseline(clean20, baseWith(2)).strength).toBe("loose");
    expect(compareToBaseline(clean20, baseWith(6)).strength).toBe("tight");
  });

  it("does not claim a behaviour change on a loose control", () => {
    const body = renderMarkdown(clean20, { baseline: baseWith(2), baselineRef: "main@abc" });
    expect(body).toContain("control is weak");
    expect(body).toContain("luck explains this result almost as well");
    expect(body).not.toContain("real change in behaviour");
  });

  it("does claim it on a tight one", () => {
    const body = renderMarkdown(clean20, { baseline: baseWith(6), baselineRef: "main@abc" });
    expect(body).toContain("fires on the base, not here");
    expect(body).toContain("real change in behaviour");
  });
});
