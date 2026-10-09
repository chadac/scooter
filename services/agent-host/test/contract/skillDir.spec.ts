/**
 * Tier 1 contract test — provider-split prompts + .claude/skills materialisation.
 *
 * Proves: the two providers get DIFFERENT prompts (no goose tool names leak
 * into the SDK's, no system-reminder sentence leaks into goose's), and the SDK
 * gets a .claude/skills tree of SKILL.md symlinks carrying a non-empty
 * description — the field it matches on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  identityCore,
  gooseAddendum,
  sdkAddendum,
  goosePrompt,
  sdkPrompt,
  loadSkills,
  writeSkillDir,
  parseFrontmatter,
} from "../../src/agent/skills.js";

let root: string;
let skillsDir: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skilldir-"));
  skillsDir = join(root, "skills");
  cwd = join(root, "cwd");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A skill file with frontmatter, as the ConfigMap ships them. */
function writeSkill(name: string, front: string, body: string): void {
  writeFileSync(join(skillsDir, `${name}.md`), `---\n${front}\n---\n\n${body}\n`, "utf8");
}

describe("provider-split prompts", () => {
  it("identityCore brands the agent and names NO provider-specific tool", () => {
    const p = identityCore({ name: "Scooter" });
    expect(p).toContain("Scooter");
    // The leak this split exists to prevent.
    for (const tool of ["tree", "read_image", "run_background"]) {
      expect(p).not.toContain(tool);
    }
  });

  it("identityCore keeps the guardrails that apply to BOTH providers", () => {
    const p = identityCore();
    expect(p).toContain("/workspace");
    expect(p).toMatch(/<title>/);
  });

  it("gooseAddendum carries the goose-only tool caveats", () => {
    const a = gooseAddendum();
    expect(a).toContain("tree");
    expect(a).toContain("read_image");
    expect(a).toContain("run_background");
  });

  it("sdkAddendum explains system reminders (a custom prompt replaces the preset)", () => {
    const a = sdkAddendum();
    expect(a.toLowerCase()).toContain("system reminder");
    // It must say reminders come from the APPLICATION, not the user.
    expect(a.toLowerCase()).toMatch(/not .*messages from the user|application/);
  });

  it("goosePrompt = core + goose addendum, and carries no SDK text", () => {
    const p = goosePrompt();
    expect(p).toContain("run_background");
    expect(p.toLowerCase()).not.toContain("system reminder");
  });

  it("sdkPrompt = core + SDK addendum, and carries no goose tool names", () => {
    const p = sdkPrompt();
    expect(p.toLowerCase()).toContain("system reminder");
    for (const tool of ["tree", "read_image", "run_background"]) {
      expect(p).not.toContain(tool);
    }
  });

  it("sdkPrompt carries NO skill bodies — the SDK discovers them itself", () => {
    writeSkill("scooter-github", "name: scooter-github\ndescription: use the broker for GitHub", "UNIQUE_BODY_MARKER");
    expect(sdkPrompt()).not.toContain("UNIQUE_BODY_MARKER");
  });
});

describe("frontmatter -> description", () => {
  it("parses description and triggers", () => {
    const fm = parseFrontmatter("---\nname: x\ndescription: do a thing\ntriggers:\n- gh pr\n- open a pr\n---\n\nbody\n");
    expect(fm.description).toBe("do a thing");
    expect(fm.triggers).toEqual(["gh pr", "open a pr"]);
  });

  it("prefers an explicit description", () => {
    writeSkill("a", "name: a\ndescription: the explicit one\ntriggers:\n- t1", "body");
    expect(loadSkills(skillsDir)[0].description).toBe("the explicit one");
  });

  it("falls back to triggers when description is absent", () => {
    writeSkill("b", "name: b\ntriggers:\n- gh pr create\n- open a pull request", "body");
    const d = loadSkills(skillsDir)[0].description;
    expect(d).toContain("gh pr create");
    expect(d).toContain("open a pull request");
  });

  it("falls back to the first prose line when both are absent", () => {
    writeSkill("c", "name: c", "# Heading\n\nThe first real sentence.\n\nmore");
    expect(loadSkills(skillsDir)[0].description).toContain("The first real sentence");
  });

  it("is NEVER empty — the SDK drops a skill with no description", () => {
    writeFileSync(join(skillsDir, "d.md"), "", "utf8");
    const d = loadSkills(skillsDir)[0].description;
    expect(d.length).toBeGreaterThan(0);
  });
});

describe("writeSkillDir", () => {
  it("creates .claude/skills/<name>/SKILL.md per skill and returns the count", () => {
    writeSkill("scooter-github", "name: scooter-github\ndescription: gh via broker", "GH BODY");
    writeSkill("scooter-aws", "name: scooter-aws\ndescription: aws via broker", "AWS BODY");
    expect(writeSkillDir(cwd, skillsDir)).toBe(2);
    for (const n of ["scooter-github", "scooter-aws"]) {
      expect(existsSync(join(cwd, ".claude", "skills", n, "SKILL.md"))).toBe(true);
    }
  });

  it("SYMLINKS rather than copying — no content duplicated", () => {
    writeSkill("x", "name: x\ndescription: d", "BODY");
    writeSkillDir(cwd, skillsDir);
    const link = join(cwd, ".claude", "skills", "x", "SKILL.md");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // and it resolves to the real content
    expect(readFileSync(link, "utf8")).toContain("BODY");
  });

  it("the symlink tracks edits at the target (a ConfigMap swap)", () => {
    writeSkill("x", "name: x\ndescription: d", "BEFORE");
    writeSkillDir(cwd, skillsDir);
    const link = join(cwd, ".claude", "skills", "x", "SKILL.md");
    expect(readFileSync(link, "utf8")).toContain("BEFORE");
    writeSkill("x", "name: x\ndescription: d", "AFTER");
    expect(readFileSync(link, "utf8")).toContain("AFTER");
  });

  it("the SKILL.md keeps its frontmatter — the SDK reads description from it", () => {
    writeSkill("x", "name: x\ndescription: the description", "BODY");
    writeSkillDir(cwd, skillsDir);
    const t = readFileSync(join(cwd, ".claude", "skills", "x", "SKILL.md"), "utf8");
    expect(t).toMatch(/^---/);
    expect(t).toContain("description:");
  });

  it("is idempotent — a second call on the same cwd does not throw", () => {
    writeSkill("x", "name: x\ndescription: d", "BODY");
    expect(writeSkillDir(cwd, skillsDir)).toBe(1);
    expect(writeSkillDir(cwd, skillsDir)).toBe(1);
  });

  it("missing skills dir -> 0, no throw", () => {
    expect(writeSkillDir(cwd, join(root, "nope"))).toBe(0);
  });
});
