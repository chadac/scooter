import { describe, expect, it } from "vitest";

import {
  MARKER,
  activeGates,
  evaluateGates,
  gateTable,
  hasSection,
  mergeSection,
  parseGates,
  parseSections,
  renderComment,
} from "./ci-report.mjs";

const GATES_YML = `
gates:
  - id: flake-full
    name: flake focus full
    require: when_labelled
    label: e2e-full-flake-check
    advisory: true
  - id: e2e-full
    name: e2e full (k3d)
    require: when_labelled
    label: e2e-full
    advisory: true
    block_while_pending: false
  - id: e2e-fast
    name: e2e fast
    require: always
  - id: size
    name: image size
    require: always
`;

const gates = parseGates(GATES_YML);
const all = activeGates(gates, ["e2e-full", "e2e-full-flake-check"]);
const section = (id, status, body = "body") => ({ id, status, body });

describe("parseGates", () => {
  it("reads the gate list in file order — that is the render order", () => {
    expect(gates.map((g) => g.id)).toEqual([
      "flake-full",
      "e2e-full",
      "e2e-fast",
      "size",
    ]);
    expect(gates[1].advisory).toBe(true);
    expect(gates[1].block_while_pending).toBe(false);
  });

  it("refuses a line it does not understand rather than guessing", () => {
    expect(() => parseGates("gates:\n  - id: a\n      weird: [1,2]\n")).toThrow(
      /cannot parse/,
    );
  });

  it("rejects a label-gated gate with no label — it could never activate", () => {
    expect(() =>
      parseGates("gates:\n  - id: a\n    require: when_labelled\n"),
    ).toThrow(/needs a label/);
  });
});

describe("activeGates", () => {
  it("leaves a label-gated suite out until the PR asks for it", () => {
    expect(activeGates(gates, []).map((g) => g.id)).toEqual([
      "e2e-fast",
      "size",
    ]);
    expect(activeGates(gates, ["e2e-full"]).map((g) => g.id)).toEqual([
      "e2e-full",
      "e2e-fast",
      "size",
    ]);
  });
});

describe("mergeSection", () => {
  it("creates the comment when there is nothing to merge into", () => {
    const body = mergeSection("", section("e2e-fast", "pass"), all);
    expect(body).toContain(MARKER);
    expect(parseSections(body).get("e2e-fast").status).toBe("pass");
  });

  it("leaves another job's section untouched", () => {
    let body = mergeSection("", section("e2e-fast", "pass", "FAST"), all);
    body = mergeSection(body, section("size", "fail", "SIZE"), all);
    const s = parseSections(body);
    expect(s.get("e2e-fast").content).toContain("FAST");
    expect(s.get("size").content).toContain("SIZE");
  });

  it("replaces its own section on a re-run instead of appending", () => {
    let body = mergeSection("", section("size", "fail", "OLD"), all);
    body = mergeSection(body, section("size", "pass", "NEW"), all);
    expect(body).not.toContain("OLD");
    expect(body.match(/ci:size:start/g)).toHaveLength(1);
  });

  it("renders sections in gate order however they arrive", () => {
    let body = mergeSection("", section("size", "pass"), all);
    body = mergeSection(body, section("e2e-full", "warn"), all);
    expect(body.indexOf("ci:e2e-full:start")).toBeLessThan(
      body.indexOf("ci:size:start"),
    );
  });

  it("keeps a section it does not know about rather than dropping it", () => {
    let body = mergeSection("", section("some-old-job", "pass", "LEGACY"), all);
    body = mergeSection(body, section("size", "pass"), all);
    expect(body).toContain("LEGACY");
  });

  it("wraps in <details> only when given a summary — a job may own its own", () => {
    const wrapped = mergeSection(
      "",
      {
        ...section("size", "pass", "TABLE"),
        summary: "image size — no growth",
      },
      all,
    );
    expect(wrapped).toContain(
      "<details><summary>✅ <b>image size — no growth</b>",
    );
    const verbatim = mergeSection(
      "",
      section("size", "pass", "<details>MINE</details>"),
      all,
    );
    expect(verbatim).toContain("<details>MINE</details>");
    expect(verbatim).not.toContain("<summary>✅");
  });

  it("round-trips multi-line markdown, tables and nested details", () => {
    const md =
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n<details>\n\ninner\n\n</details>";
    const body = mergeSection("", section("e2e-full", "warn", md), all);
    expect(parseSections(body).get("e2e-full").content).toBe(md);
  });
});

describe("evaluateGates", () => {
  it("treats a gate nobody reported as blocking, never as passing", () => {
    const v = evaluateGates(parseSections(""), all);
    // e2e-full opts out of blocking while pending; the rest do not.
    expect(v.pending).toEqual(["flake-full", "e2e-fast", "size"]);
    expect(v.mergeable).toBe(false);
  });

  it("blocks on a required failure and not on an advisory one", () => {
    let body = mergeSection("", section("e2e-fast", "pass"), all);
    body = mergeSection(body, section("size", "pass"), all);
    body = mergeSection(body, section("flake-full", "fail"), all);
    body = mergeSection(body, section("e2e-full", "fail"), all);
    const v = evaluateGates(parseSections(body), all);
    expect(v.blocking).toEqual([]);
    expect(v.mergeable).toBe(true);
  });

  it("blocks on a required failure", () => {
    let body = mergeSection("", section("e2e-fast", "fail"), all);
    body = mergeSection(body, section("size", "pass"), all);
    body = mergeSection(body, section("flake-full", "pass"), all);
    const v = evaluateGates(parseSections(body), all);
    expect(v.blocking).toEqual(["e2e-fast"]);
    expect(v.mergeable).toBe(false);
  });

  it("counts a skipped gate as satisfied — it was not asked to run", () => {
    let body = mergeSection("", section("e2e-fast", "skip"), all);
    body = mergeSection(body, section("size", "pass"), all);
    body = mergeSection(body, section("flake-full", "skip"), all);
    expect(evaluateGates(parseSections(body), all).mergeable).toBe(true);
  });
});

describe("gateTable", () => {
  it("shows every active gate, pending ones included", () => {
    const body = mergeSection("", section("size", "pass"), all);
    const table = gateTable(parseSections(body), all);
    expect(table).toContain("| image size | required | ✅ pass |");
    expect(table).toContain("| e2e fast | required | ⏳ pending |");
    expect(table).toContain("| e2e full (k3d) | advisory | ⏳ pending |");
  });

  it("leads the comment with the verdict, so a reader needs no expansion", () => {
    const body = mergeSection("", section("e2e-fast", "fail"), all);
    expect(body.split("\n")[2]).toContain("gate");
    expect(body.indexOf("| gate |")).toBeLessThan(
      body.indexOf("ci:e2e-fast:start"),
    );
  });
});

describe("hasSection", () => {
  it("detects a section clobbered by a racing write", () => {
    const mine = section("size", "pass");
    const body = mergeSection("", mine, all);
    expect(hasSection(body, mine)).toBe(true);
    // Another job re-rendered from a body that predates ours.
    const clobbered = mergeSection("", section("e2e-fast", "pass"), all);
    expect(hasSection(clobbered, mine)).toBe(false);
  });
});

describe("renderComment", () => {
  it("is stable: re-rendering a parsed body reproduces it", () => {
    let body = mergeSection("", section("e2e-fast", "pass", "A"), all);
    body = mergeSection(body, section("size", "warn", "B"), all);
    expect(renderComment(parseSections(body), all)).toBe(body);
  });
});
