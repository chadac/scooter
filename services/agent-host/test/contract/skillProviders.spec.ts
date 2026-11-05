/** Skill providers: sandbox commands whose skills fill gaps. */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import {
  MAX_PROVIDED_SKILL_BYTES,
  MAX_PROVIDED_TOTAL_BYTES,
  parseFrontmatter,
  pickProvidedSkills,
  providedSkill,
  renderSkillFile,
  type ProvidedSkillFile,
} from "../../src/agent/skills.js";
import {
  createSkillProviderRegistry,
  parseProvidedSkills,
  parseSkillProviders,
  type ProviderExec,
  type SkillProviderDef,
} from "../../src/agent/skillProviders.js";
import type { ExecResult } from "../../src/types.js";

const file = (name: string, content = `---\nname: ${name}\ndescription: Use for ${name}.\n---\n# ${name}\n`): ProvidedSkillFile => ({
  name,
  dir: `/workspace/.skills/${name}`,
  content,
});

describe("frontmatter as published skills write it", () => {
  it("folds a `>` block scalar into one line", () => {
    const fm = parseFrontmatter("---\nname: x\ndescription: >\n  Use when the\n  user asks.\nlicense: MIT\n---\nbody");
    expect(fm.description).toBe("Use when the user asks.");
    expect(fm.license).toBe("MIT");
  });

  it("keeps a `|-` block scalar's lines", () => {
    expect(parseFrontmatter("---\ndescription: |-\n  one\n  two\n---\n").description).toBe("one\ntwo");
  });

  it("unquotes double- and single-quoted values", () => {
    const fm = parseFrontmatter(`---\ndescription: "Use \\"this\\": now"\nother: 'it''s'\n---\n`);
    expect(fm.description).toBe('Use "this": now');
    expect(fm.other).toBe("it's");
  });
});

describe("providedSkill", () => {
  it("names the sandbox directory after the frontmatter, so relative paths resolve there", () => {
    const s = providedSkill(file("pdf"));
    expect(s.description).toBe("Use for pdf.");
    const rendered = renderSkillFile(s);
    expect(rendered).toMatch(/^---\nname: pdf\n/);
    expect(rendered).toContain("`/workspace/.skills/pdf`, in your sandbox");
    expect(rendered.indexOf("in your sandbox")).toBeLessThan(rendered.indexOf("# pdf"));
  });

  it("adds no note for a skill without a directory", () => {
    const { dir: _dir, ...f } = file("pdf");
    expect(renderSkillFile(providedSkill(f))).not.toContain("in your sandbox");
  });
});

describe("pickProvidedSkills", () => {
  it("drops a name a deployment or personal skill already has", () => {
    const { skills, dropped } = pickProvidedSkills([file("agent-tools"), file("pdf")], new Set(["agent-tools"]));
    expect(skills.map((s) => s.name)).toEqual(["pdf"]);
    expect(dropped).toEqual([{ name: "agent-tools", reason: "a deployment or personal skill has this name" }]);
  });

  it("keeps the first of two providers' skills with one name", () => {
    const plain = (content: string) => ({ name: "pdf", content });
    const { skills, dropped } = pickProvidedSkills([plain("first"), plain("second")], new Set());
    expect(skills.map((s) => s.text)).toEqual(["first"]);
    expect(dropped).toEqual([{ name: "pdf", reason: "an earlier provider has this name" }]);
  });

  it("drops a path-unsafe name", () => {
    expect(pickProvidedSkills([file("../x")], new Set()).skills).toEqual([]);
  });

  it("applies the per-skill and total byte budgets in name order", () => {
    const big = (n: string) => file(n, "x".repeat(MAX_PROVIDED_SKILL_BYTES - 10));
    const files = [file("huge", "x".repeat(MAX_PROVIDED_SKILL_BYTES + 1)), ...["a", "b", "c", "d", "e"].map(big)];
    const { skills, dropped } = pickProvidedSkills(files, new Set());
    const total = MAX_PROVIDED_TOTAL_BYTES / (MAX_PROVIDED_SKILL_BYTES - 10);
    expect(skills.map((s) => s.name)).toEqual(["a", "b", "c", "d", "e"].slice(0, Math.floor(total)));
    expect(dropped.find((d) => d.name === "huge")?.reason).toMatch(/^over /);
    expect(dropped.some((d) => /in total/.test(d.reason))).toBe(true);
  });
});

describe("parseSkillProviders", () => {
  it("keeps well-formed rows, caps the wait at the timeout and drops the rest", () => {
    const warns: string[] = [];
    const rows = parseSkillProviders(
      JSON.stringify([
        { id: "a.x", command: "echo", timeoutSec: 60, waitSec: 90 },
        { id: "b", command: "echo" },
        { id: "", command: "echo" },
        { id: "c", command: " " },
      ]),
      (m) => warns.push(m),
    );
    expect(rows.map((r) => [r.id, r.timeoutSec, r.waitSec])).toEqual([["a.x", 60, 60], ["b", 30, 30]]);
    expect(warns).toHaveLength(2);
  });

  it("answers none for unset or invalid JSON", () => {
    expect(parseSkillProviders(undefined)).toEqual([]);
    expect(parseSkillProviders("{nope")).toEqual([]);
  });
});

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const answer = (...files: ProvidedSkillFile[]) => ok(JSON.stringify({ skills: files }));
const provider = (id: string, over: Partial<SkillProviderDef> = {}): SkillProviderDef => ({
  id,
  command: `provide ${id}`,
  timeoutSec: 30,
  waitSec: 30,
  description: "",
  ...over,
});

/** A pod answering each provider's command, recording each call. */
function fakePod(providers: SkillProviderDef[], handlers: Record<string, () => Promise<ExecResult>>) {
  const calls: Array<{ command: string; script: string; stdin?: string }> = [];
  const exec: ProviderExec = {
    async execute(req) {
      calls.push({ command: req.command, script: req.args[1], stdin: req.stdin });
      const h = handlers[req.args[1]];
      return h ? h() : ok(JSON.stringify({ skills: [] }));
    },
  };
  const registry = createSkillProviderRegistry(
    { providers, sandboxFor: () => ({ name: "sb", namespace: "ns" }), connect: async () => exec },
    { ttlMs: 0 },
  );
  return { registry, calls };
}

describe("skill provider registry", () => {
  it("runs each provider's script with the conversation on stdin, in id order", async () => {
    const { registry, calls } = fakePod([provider("b"), provider("a")], {
      "provide a": async () => answer(file("from-a")),
      "provide b": async () => answer(file("from-b")),
    });
    expect((await registry.skills("c1", "alice")).map((f) => f.name)).toEqual(["from-a", "from-b"]);
    expect(calls[0].command).toBe("bash");
    expect(JSON.parse(calls[0].stdin!)).toEqual({ conversation_id: "c1", owner: "alice" });
  });

  it("does not hold a message past the provider's wait, and offers the late answer next time", async () => {
    let finish!: () => void;
    const { registry, calls } = fakePod([provider("slow", { waitSec: 0.02 })], {
      "provide slow": () => new Promise((resolve) => (finish = () => resolve(answer(file("late"))))),
    });
    const started = Date.now();
    expect(await registry.skills("c1")).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect((await registry.skills("c1")).map((f) => f.name)).toEqual(["late"]);
    expect(calls).toHaveLength(2);
  });

  it("keeps the last good answer when a provider fails", async () => {
    let fail = false;
    const { registry } = fakePod([provider("p")], {
      "provide p": async () => (fail ? { stdout: "", stderr: "boom", exitCode: 1 } : answer(file("pdf"))),
    });
    await registry.skills("c1");
    fail = true;
    expect((await registry.skills("c1")).map((f) => f.name)).toEqual(["pdf"]);
  });

  it("stops asking a sandbox that lacks the provider's command", async () => {
    const { registry, calls } = fakePod([provider("p")], {
      "provide p": async () => ({ stdout: "", stderr: "not found", exitCode: 127 }),
    });
    expect(await registry.skills("c1")).toEqual([]);
    await registry.skills("c1");
    expect(calls).toHaveLength(1);
  });

  it("answers none without a sandbox, running nothing", async () => {
    const calls: unknown[] = [];
    const registry = createSkillProviderRegistry({
      providers: [provider("p")],
      sandboxFor: () => undefined,
      connect: async () => ({ execute: async () => (calls.push(1), ok()) }),
    });
    expect(await registry.skills("c1")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("parseProvidedSkills drops malformed entries and rejects other shapes", () => {
    expect(parseProvidedSkills(JSON.stringify({ skills: [file("a"), { name: 1 }] })).map((f) => f.name)).toEqual(["a"]);
    expect(() => parseProvidedSkills("{}")).toThrow();
  });
});

describe("echo's sample provider", () => {
  // The same script contrib/echo declares and the k3d e2e render runs.
  const script = readFileSync(new URL("../../../../contrib/echo/skill-provider.sh", import.meta.url), "utf8");
  const localExec: ProviderExec = {
    async execute(req) {
      const r = spawnSync(req.command, req.args, { input: req.stdin, encoding: "utf8" });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
    },
  };

  it("runs under bash and is offered next to the deployment's skills", async () => {
    const registry = createSkillProviderRegistry({
      providers: [provider("echo.hello", { command: script })],
      sandboxFor: () => ({ name: "sb", namespace: "ns" }),
      connect: async () => localExec,
    });
    const files = await registry.skills("c1", "alice");
    const { skills, dropped } = pickProvidedSkills(files, new Set(["agent-tools"]));
    expect(dropped).toEqual([]);
    expect(skills.map((s) => [s.name, s.description])).toEqual([["echo-provided", "Use when testing skill providers."]]);
    expect(renderSkillFile(skills[0])).toContain("echo-provided-skill-marker");
  });
});
