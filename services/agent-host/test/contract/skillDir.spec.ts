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

  it("writes a REAL file, not a symlink — the SDK parses frontmatter from it", () => {
    writeSkill("x", "name: x\ndescription: d", "BODY");
    writeSkillDir(cwd, skillsDir);
    const p = join(cwd, ".claude", "skills", "x", "SKILL.md");
    expect(lstatSync(p).isSymbolicLink()).toBe(false);
    expect(readFileSync(p, "utf8")).toContain("BODY");
  });

  it("THE BUG: triggers and NO description -> a WHEN-to-use description", () => {
    // Every shipped skill is shaped like this. Proven live: with only the H1
    // heading as its description the agent answers `gh pr create`; with the
    // triggers in the description it answers `agent-broker`.
    writeSkill(
      "scooter-github",
      "name: scooter-github\ntype: knowledge\ntriggers:\n- gh pr create\n- open a pull request",
      "# GitHub from a Scooter sandbox\n\nUse agent-broker.",
    );
    writeSkillDir(cwd, skillsDir);
    const t = readFileSync(join(cwd, ".claude", "skills", "scooter-github", "SKILL.md"), "utf8");
    expect(t).toContain("gh pr create");
    expect(t).toContain("open a pull request");
    expect(t).toContain("GitHub from a Scooter sandbox");
    expect(t).toContain("Use agent-broker.");
  });

  it("the description is ONE line — a stray newline breaks the YAML", () => {
    writeSkill("x", "name: x\ntriggers:\n- a\n- b", "# Multi\nline\n\nbody");
    writeSkillDir(cwd, skillsDir);
    const t = readFileSync(join(cwd, ".claude", "skills", "x", "SKILL.md"), "utf8");
    // frontmatter holds exactly name + description, no wrapped lines
    expect(t.split("---")[1].trim().split("\n")).toHaveLength(2);
  });

  it("the SKILL.md keeps its frontmatter — the SDK reads description from it", () => {
    writeSkill("x", "name: x\ndescription: the description", "BODY");
    writeSkillDir(cwd, skillsDir);
    const t = readFileSync(join(cwd, ".claude", "skills", "x", "SKILL.md"), "utf8");
    expect(t).toMatch(/^---/);
    expect(t).toContain("description:");
  });

  it("REGRESSION: a source with triggers but NO description still gets one", () => {
    // Every shipped skill looks like this — name/type/version/triggers, no
    // description. Symlinking such a file gives the SDK nothing to match on,
    // so it drops the skill silently.
    writeSkill("scooter-github", "name: scooter-github\ntype: knowledge\ntriggers:\n- gh pr create\n- open a pull request", "GH BODY");
    writeSkillDir(cwd, skillsDir);
    const t = readFileSync(join(cwd, ".claude", "skills", "scooter-github", "SKILL.md"), "utf8");
    expect(t).toContain("description:");
    // and the description must carry the trigger phrases, which is what the
    // model matches the task against
    expect(t).toContain("gh pr create");
    // the body must survive too
    expect(t).toContain("GH BODY");
  });

  it("REGRESSION: an empty-frontmatter source still gets a description", () => {
    writeFileSync(join(skillsDir, "bare.md"), "just a body, no frontmatter\n", "utf8");
    writeSkillDir(cwd, skillsDir);
    const t = readFileSync(join(cwd, ".claude", "skills", "bare", "SKILL.md"), "utf8");
    expect(t).toMatch(/^---/);
    expect(t).toContain("description:");
    expect(t).toContain("just a body");
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
