import { describe, expect, it } from "vitest";

import { marker, patternToRegExp, renderMarkdown, summarize } from "./flake-focus-report.mjs";

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
