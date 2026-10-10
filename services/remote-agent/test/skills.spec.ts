/**
 * Tier 1 — skill delivery to a BYO container.
 *
 * The container cannot read the agent-host pod's filesystem, so skills arrive as
 * DATA on new_session and are written locally. Names become PATH SEGMENTS and
 * come off a wire, so the escape guard is part of the contract.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSkillPayloads } from "../src/skills.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "byoc-skills-")); });
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("writeSkillPayloads", () => {
  it("writes .claude/skills/<name>/SKILL.md, the layout the SDK discovers", () => {
    const n = writeSkillPayloads(cwd, [
      { name: "scooter-github", content: "---\nname: scooter-github\ndescription: d\n---\n\nUse agent-broker.\n" },
    ]);
    expect(n).toBe(1);
    const p = join(cwd, ".claude", "skills", "scooter-github", "SKILL.md");
    expect(existsSync(p)).toBe(true);
    const t = readFileSync(p, "utf8");
    // The frontmatter must survive: the SDK reads `description` from it.
    expect(t).toMatch(/^---/);
    expect(t).toContain("description:");
    expect(t).toContain("Use agent-broker.");
  });

  it("writes every skill it is given", () => {
    const n = writeSkillPayloads(cwd, [
      { name: "a", content: "A" },
      { name: "b", content: "B" },
      { name: "c", content: "C" },
    ]);
    expect(n).toBe(3);
    for (const name of ["a", "b", "c"]) {
      expect(existsSync(join(cwd, ".claude", "skills", name, "SKILL.md"))).toBe(true);
    }
  });

  it("REFUSES a name that would escape the skills directory", () => {
    // These arrive over a wire. A traversal name must not write outside cwd.
    const n = writeSkillPayloads(cwd, [
      { name: "../../../etc/evil", content: "x" },
      { name: "..", content: "x" },
      { name: "a/b", content: "x" },
      { name: ".hidden", content: "x" },
      { name: "ok", content: "fine" },
    ]);
    expect(n).toBe(1);
    expect(existsSync(join(cwd, ".claude", "skills", "ok", "SKILL.md"))).toBe(true);
    // nothing landed above the skills dir
    expect(existsSync(join(cwd, "..", "etc"))).toBe(false);
  });

  it("no skills -> 0, and no directory is created", () => {
    expect(writeSkillPayloads(cwd, [])).toBe(0);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });
});
