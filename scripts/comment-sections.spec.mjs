import { describe, expect, it } from "vitest";

import {
  HEADING,
  MARKER,
  hasSection,
  mergeSection,
  parseSections,
  renderComment,
} from "./comment-sections.mjs";

describe("mergeSection", () => {
  it("creates the comment when there is nothing to merge into", () => {
    const body = mergeSection("", "fast", "### ✅ fast — clean");
    expect(body).toContain(MARKER);
    expect(body).toContain(HEADING);
    expect(body).toContain("### ✅ fast — clean");
  });

  // The reason this file exists: the full-target job must not wipe the fast
  // job's verdict (or vice versa) when it writes into the shared comment.
  it("leaves the other target's section untouched", () => {
    const withFast = mergeSection("", "fast", "FAST VERDICT");
    const both = mergeSection(withFast, "full", "FULL VERDICT");
    expect(both).toContain("FAST VERDICT");
    expect(both).toContain("FULL VERDICT");
  });

  it("replaces its own section on a re-run rather than appending", () => {
    const first = mergeSection(mergeSection("", "fast", "OLD"), "full", "FULL");
    const second = mergeSection(first, "fast", "NEW");
    expect(second).not.toContain("OLD");
    expect(second).toContain("NEW");
    expect(second).toContain("FULL");
    expect(parseSections(second).size).toBe(2);
  });

  it("renders fast before full regardless of which job wrote first", () => {
    const fullFirst = mergeSection(mergeSection("", "full", "FULL"), "fast", "FAST");
    expect(fullFirst.indexOf("FAST")).toBeLessThan(fullFirst.indexOf("FULL"));
  });

  // A section this job does not know about (an older or newer target) must
  // survive: dropping it would silently delete another job's answer.
  it("preserves sections it does not know about", () => {
    const exotic = mergeSection("", "cluster-nightly", "SOMETHING ELSE");
    expect(mergeSection(exotic, "fast", "FAST")).toContain("SOMETHING ELSE");
  });

  it("round-trips multi-line markdown, including tables and details blocks", () => {
    const content = "### ✅ fast\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<details><summary>x</summary>\n\ny\n\n</details>";
    expect(parseSections(mergeSection("", "fast", content)).get("fast")).toBe(content);
  });
});

describe("hasSection", () => {
  // The post-write check that drives the retry when the two jobs race.
  it("is true only when that exact content is present", () => {
    const body = mergeSection("", "fast", "MINE");
    expect(hasSection(body, "fast", "MINE")).toBe(true);
    expect(hasSection(body, "fast", "SOMETHING ELSE")).toBe(false);
    expect(hasSection(body, "full", "MINE")).toBe(false);
    expect(hasSection("", "fast", "MINE")).toBe(false);
  });

  it("detects a section clobbered by a racing job", () => {
    const mine = mergeSection("", "fast", "MINE");
    // The other job read the comment BEFORE we wrote, so its write drops our section.
    const raced = mergeSection("", "full", "THEIRS");
    expect(hasSection(raced, "fast", "MINE")).toBe(false);
    expect(hasSection(mergeSection(raced, "fast", "MINE"), "fast", "MINE")).toBe(true);
    expect(mine).toContain("MINE");
  });
});

describe("renderComment", () => {
  it("is stable: re-rendering a parsed body reproduces it", () => {
    const body = mergeSection(mergeSection("", "fast", "FAST"), "full", "FULL");
    expect(renderComment(parseSections(body))).toBe(body);
  });
});
