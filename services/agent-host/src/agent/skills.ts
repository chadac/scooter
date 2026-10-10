/**
 * Skills + agent identity -> a prompt, per provider.
 *
 * TWO providers consume this, and they want DIFFERENT shapes:
 *
 *   goose  - reads `.goosehints` from its cwd, with every skill body inlined.
 *   claude - takes a `systemPrompt` string, and discovers skills itself from
 *            `.claude/skills/<name>/SKILL.md` (name + description up front,
 *            body on demand). So its prompt carries NO skill bodies.
 *
 * Keep the provider-specific text in gooseAddendum/sdkAddendum, never in
 * identityCore: goose tool names (`tree`, `run_background`) are meaningless to
 * the SDK, and the SDK's system-reminder sentence is meaningless to goose.
 *
 * The agent (branded "Scooter") reads a `.goosehints` file from its
 * working directory. We assemble that file per conversation from:
 *   1. a base identity prompt (who Scooter is, how it behaves), and
 *   2. the markdown "skills" — each a frontmatter + body doc giving Scooter
 *      knowledge/instructions (e.g. "the main repo is X, clone it with ...").
 *
 * Skills are read from a directory at runtime (a ConfigMap mount in cluster, a
 * local dir in dev), so adding/editing a skill needs no image rebuild — drop a
 * .md file in the dir (or edit the ConfigMap) and new conversations pick it up.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";

export interface AgentIdentity {
  /** Display name the agent goes by. */
  name: string;
  /** Optional extra persona/behavior lines appended to the base prompt. */
  persona?: string;
}

const DEFAULT_IDENTITY: AgentIdentity = { name: "Scooter" };

/**
 * Provider-neutral identity + behaviour. NOTHING here may name a tool that
 * only one provider has.
 */
export function identityCore(id: AgentIdentity = DEFAULT_IDENTITY): string {
  return [
    `You are ${id.name}, an AI coding agent.`,
    `Refer to yourself as ${id.name}. When asked your name, say you are ${id.name}.`,
    `You work inside a per-conversation Nix sandbox: a Linux environment where`,
    `your shell commands run. Packages are managed with Nix. Be concise and act`,
    `directly — run commands to inspect and change the workspace rather than`,
    `guessing.`,
    // Runaway-command guardrail: this is a NixOS box, so /nix/store is enormous.
    // A recursive search from / never finishes and is killed at a ~5min timeout.
    `Your work lives under \`/workspace\`. NEVER search the whole filesystem`,
    `(\`grep -r … /\`, \`find / …\`) — /nix/store is huge and the command will be`,
    `killed at a ~5min timeout. Scope searches to \`/workspace\` (or a specific`,
    `repo).`,
    // Conversation titling: the host extracts a <title>…</title> marker from the
    // very start of your reply and uses it to name the conversation.
    `At the very START of your FIRST reply in a conversation, emit a concise`,
    `(3–6 word) title for the task wrapped in a <title> tag, e.g.`,
    `"<title>Fix the login redirect</title>". Put it before anything else and do`,
    `it only once, on the first reply. The tag is hidden from the user.`,
    id.persona ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * goose-only caveats: the tools that read the wrong filesystem, and
 * run_background. Appended to identityCore for the goose path only.
 */
export function gooseAddendum(): string {
  return [
    // Only the developer extension's read/write/edit/shell tools run in the
    // sandbox. `tree` and `read_image` read the HOST's filesystem.
    `IMPORTANT: do NOT use the \`tree\` or \`read_image\` tools — they read a`,
    `different machine's filesystem, not your sandbox, so their results are wrong.`,
    `To list or explore directories, use the \`shell\` tool with \`ls\`, \`ls -R\`,`,
    `or \`find\` instead — those run in your sandbox and see the real workspace.`,
    `For a long job (a build, a test suite), use the \`run_background\` tool so it`,
    `doesn't block your turn or hit the timeout.`,
  ].join("\n");
}

/**
 * claude-SDK-only preamble. A custom systemPrompt replaces the whole
 * claude_code preset, so the model is told what a system reminder is --
 * otherwise it cannot tell CLAUDE.md content, hook output and the skill list
 * from user messages.
 */
export function sdkAddendum(): string {
  return [
    // A custom systemPrompt replaces the whole claude_code preset, which is
    // where this explanation normally lives. Without it nothing tells the model
    // that CLAUDE.md content, hook output and the skill list are application
    // context rather than user speech.
    `The application adds system reminders to this conversation. Treat them as`,
    `context from the application, not as messages from the user.`,
    // Skills arrive as name + description; the body loads on demand.
    `Your available skills are listed as system reminders. When a task falls in a`,
    `skill's area, read that skill BEFORE acting — it is authoritative for this`,
    `environment and overrides your general assumptions.`,
  ].join("\n");
}

/** goose's full prompt: core + its addendum. */
export function goosePrompt(id: AgentIdentity = DEFAULT_IDENTITY): string {
  return `${identityCore(id)}\n${gooseAddendum()}`;
}

/** The SDK's full prompt: core + its addendum. Carries no skill bodies. */
export function sdkPrompt(id: AgentIdentity = DEFAULT_IDENTITY): string {
  return `${identityCore(id)}\n${sdkAddendum()}`;
}

/** @deprecated goose-shaped alias, kept so existing callers/tests still build. */
export function identityPrompt(id: AgentIdentity = DEFAULT_IDENTITY): string {
  return goosePrompt(id);
}

/** A loaded skill: its name, parsed frontmatter, and markdown. */
export interface Skill {
  /** Directory-safe name, from the filename. */
  name: string;
  /** Full file text, frontmatter included. */
  text: string;
  /**
   * What the SDK matches on to decide a skill is relevant. From frontmatter
   * `description`, else `triggers` folded into a sentence, else the first
   * prose line. NEVER empty -- the SDK drops a skill with no description.
   */
  description: string;
}

/** Read every `*.md` skill from `dir` (sorted by name; missing dir -> []). */
export function loadSkills(dir: string): Skill[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const name = f.replace(/\.md$/, "");
      const text = readFileSync(join(dir, f), "utf8");
      return { name, text, description: skillDescription(name, text) };
    });
}

/** Assemble the full `.goosehints` content: identity + each skill's body. */
export function assembleHints(skills: Skill[], identity: AgentIdentity = DEFAULT_IDENTITY): string {
  const parts = [identityPrompt(identity)];
  if (skills.length) {
    parts.push("\n# Skills\n\nThe following skills give you knowledge and instructions for this environment.\n");
    for (const s of skills) parts.push(stripFrontmatter(s.text).trim());
  }
  return parts.join("\n\n") + "\n";
}

/**
 * Write the conversation's `.goosehints` into `cwd` (goose reads it from there).
 * Returns the number of skills included. Safe to call on every conversation
 * start — it just overwrites the hints with the current skills.
 */
export function writeHints(
  cwd: string,
  skillsDir: string,
  identity: AgentIdentity = DEFAULT_IDENTITY,
): number {
  const skills = loadSkills(skillsDir);
  writeFileSync(join(cwd, ".goosehints"), assembleHints(skills, identity), "utf8");
  return skills.length;
}

/** A skill as it travels to a BYO container: name + the rendered SKILL.md. */
export interface SkillPayload {
  name: string;
  /** The full SKILL.md text, frontmatter included. */
  content: string;
}

/**
 * The skills to SEND a BYO container, which has no access to this pod's
 * filesystem. It writes them itself (writeSkillPayloads) and its own SDK then
 * discovers them exactly as the in-pod one does.
 */
export function skillPayloads(skillsDir: string): SkillPayload[] {
  return loadSkills(skillsDir).map((s) => ({ name: s.name, content: renderSkillFile(s) }));
}

/**
 * Write received payloads as `.claude/skills/<name>/SKILL.md` under `cwd`.
 * The container-side counterpart of writeSkillDir -- same layout, no shared
 * filesystem. Returns the number written.
 */
export function writeSkillPayloads(cwd: string, skills: readonly SkillPayload[]): number {
  if (!skills.length) return 0;
  const base = join(cwd, ".claude", "skills");
  for (const s of skills) {
    // A hostile/garbled name must not escape the skills dir.
    if (!/^[A-Za-z0-9._-]+$/.test(s.name) || s.name.startsWith(".")) continue;
    const dir = join(base, s.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), s.content, "utf8");
  }
  return skills.length;
}

/**
 * Materialise `.claude/skills/<name>/SKILL.md` under `cwd` for the SDK to
 * discover, SYMLINKING each SKILL.md at its file in `skillsDir` (a ConfigMap
 * mount in cluster) so no content is copied and a ConfigMap edit propagates.
 *
 * Returns the number of skills linked.
 */
export function writeSkillDir(
  cwd: string,
  skillsDir: string,
): number {
  const skills = loadSkills(skillsDir);
  if (!skills.length) return 0;
  const base = join(cwd, ".claude", "skills");
  for (const s of skills) {
    const dir = join(base, s.name);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "SKILL.md");
    rmSync(dest, { force: true });
    // A WRITTEN file, not a symlink. The SDK parses frontmatter from the file
    // it finds, and our skills carry `triggers:` but no `description:` -- so a
    // symlink to the original leaves the SDK falling back to the H1 heading
    // ("GitHub from a Scooter sandbox"), which says nothing about WHEN to use
    // the skill. Proven live: with that heading the agent answers
    // `gh pr create`; with a trigger-bearing description it answers
    // `agent-broker`. So we must rewrite the frontmatter.
    writeFileSync(dest, renderSkillFile(s), "utf8");
  }
  return skills.length;
}

/**
 * The SKILL.md the SDK reads: our computed `description` (which carries the
 * trigger phrases the model matches on) over the original body.
 */
export function renderSkillFile(s: Skill): string {
  const body = stripFrontmatter(s.text).trim();
  // Only name + description: the SDK needs those two, and the original
  // `triggers:`/`type:`/`version:` fields mean nothing to it.
  return [
    "---",
    `name: ${s.name}`,
    // Single-line, quoted: a stray newline or colon would break the YAML and
    // the SDK drops a skill whose frontmatter does not parse.
    `description: ${JSON.stringify(s.description.replace(/\s+/g, " ").trim())}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** Parse `name`/`description`/`triggers` out of a skill's frontmatter. */
export function parseFrontmatter(md: string): Record<string, string | string[]> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of m[1].split("\n")) {
    // A `- item` line continues the list opened by the last `key:` with no value.
    const item = raw.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      (out[listKey] as string[]).push(item[1].trim());
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val.trim() === "") {
      listKey = key;
      out[key] = [];
    } else {
      listKey = null;
      out[key] = val.trim();
    }
  }
  return out;
}

/**
 * The description the SDK matches on. Never empty: a skill with no description
 * is dropped, so fall back through triggers to the first prose line to the name.
 */
function skillDescription(name: string, md: string): string {
  const fm = parseFrontmatter(md);
  const explicit = typeof fm.description === "string" ? fm.description : "";
  if (explicit) return explicit;
  const triggers = Array.isArray(fm.triggers) ? fm.triggers : [];
  // Lead with the H1, then the skill's own opening prose. NOT a trigger dump:
  // proven live on the same pod and body, only the description differing --
  // "Use when the task involves: gh, gh cli, gh pr create, ..." gets
  // `gh pr create`, while a prose sentence naming the CONSTRAINT gets
  // `agent-broker`. A keyword list reads as a topic label; the model needs a
  // statement of when the skill applies and what it changes.
  const body = stripFrontmatter(md);
  const heading = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("# "))
    ?.replace(/^#\s*/, "");
  // The first paragraph after the heading: skills open with "Applies when ..."
  // or similar, which is exactly the when-to-use sentence we want.
  const firstPara = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("```"));
  if (heading && firstPara) return `${heading}. ${stripMarkdown(firstPara)}`;
  if (heading && triggers.length) {
    // No usable prose: fall back to triggers, but phrase them as a condition.
    return `${heading}. Use this when the task involves ${triggers.slice(0, 6).join(", ")}.`;
  }
  if (firstPara) return stripMarkdown(firstPara);
  if (heading) return heading;
  const prose = stripFrontmatter(md)
    .split("\n")
    .map((l) => l.trim())
    // Skip headings, fences and blanks — the first SENTENCE is what we want.
    .find((l) => l && !l.startsWith("#") && !l.startsWith("```"));
  return prose || `The ${name} skill for this environment.`;
}

/** Strip markdown emphasis/links so a description reads as plain prose. */
function stripMarkdown(t: string): string {
  return t
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\([^)]*\)/g, "$1");
}

/** Drop a leading `---\n...\n---` YAML frontmatter block, keeping the body. */
function stripFrontmatter(md: string): string {
  const m = md.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? md.slice(m[0].length) : md;
}
