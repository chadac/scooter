/**
 * Tier 1 contract test — skills -> .goosehints assembly + injection.
 *
 * Proves: the agent identity (Scooter) + markdown skills are assembled into a
 * .goosehints file in the conversation cwd (which goose reads), frontmatter is
 * stripped, and adding a skill file is all it takes (no rebuild).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identityPrompt, loadSkills, assembleHints, writeHints } from "../../src/agent/skills.js";

let root: string;
let skillsDir: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-"));
  skillsDir = join(root, "skills");
  cwd = join(root, "cwd");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("agent skills -> .goosehints", () => {
  it("identityPrompt brands the agent (Scooter by default)", () => {
    expect(identityPrompt()).toContain("You are Scooter");
    expect(identityPrompt({ name: "Ziggy" })).toContain("You are Ziggy");
  });

  it("identityPrompt steers the agent away from the host-reading `tree`/`read_image` tools", () => {
    // goose's `tree`/`read_image` developer tools run in the agent-host pod, not
    // the sandbox, and can't be disabled via config (goose wipes available_tools).
    // The instruction is the only guard — it must be present and name the fix.
    const p = identityPrompt();
    expect(p).toContain("tree");
    expect(p).toContain("read_image");
    expect(p).toMatch(/shell|ls|find/); // points at the sandbox-routed alternative
  });

  it("loadSkills reads *.md, sorted; missing dir -> []", () => {
    writeFileSync(join(skillsDir, "b.md"), "B");
    writeFileSync(join(skillsDir, "a.md"), "A");
    writeFileSync(join(skillsDir, "notes.txt"), "ignored");
    const skills = loadSkills(skillsDir);
    expect(skills.map((s) => s.name)).toEqual(["a", "b"]);
    expect(loadSkills(join(root, "nope"))).toEqual([]);
  });

  it("assembleHints includes identity + each skill body, frontmatter stripped", () => {
    const skills = [
      { name: "repo", text: "---\nname: repo\ntriggers:\n- clone\n---\n\nThe main repo is github.com/acme/app. Clone it with `git clone`." },
    ];
    const hints = assembleHints(skills, { name: "Scooter" });
    expect(hints).toContain("You are Scooter");
    expect(hints).toContain("# Skills");
    expect(hints).toContain("The main repo is github.com/acme/app");
    // frontmatter (name:/triggers:) must NOT leak into the prompt
    expect(hints).not.toContain("triggers:");
  });

  it("writeHints drops a .goosehints in cwd and returns the skill count", () => {
    writeFileSync(join(skillsDir, "project.md"), "---\nname: project\n---\n\nClone github.com/example-org/example-app to get started.");
    const n = writeHints(cwd, skillsDir, { name: "Scooter" });

    expect(n).toBe(1);
    const hints = readFileSync(join(cwd, ".goosehints"), "utf8");
    expect(hints).toContain("You are Scooter");
    expect(hints).toContain("Clone github.com/example-org/example-app");
  });

  it("writeHints with no skills still writes the identity prompt", () => {
    const n = writeHints(cwd, skillsDir, { name: "Scooter" });
    expect(n).toBe(0);
    expect(existsSync(join(cwd, ".goosehints"))).toBe(true);
    expect(readFileSync(join(cwd, ".goosehints"), "utf8")).toContain("You are Scooter");
  });
});
