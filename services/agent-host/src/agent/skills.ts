/**
 * Skills + agent identity -> goose hints.
 *
 * The agent (goose, branded "Scooter") reads a `.goosehints` file from its
 * working directory. We assemble that file per conversation from:
 *   1. a base identity prompt (who Scooter is, how it behaves), and
 *   2. the markdown "skills" — each a frontmatter + body doc giving Scooter
 *      knowledge/instructions (e.g. "the main repo is X, clone it with ...").
 *
 * Skills are read from a directory at runtime (a ConfigMap mount in cluster, a
 * local dir in dev), so adding/editing a skill needs no image rebuild — drop a
 * .md file in the dir (or edit the ConfigMap) and new conversations pick it up.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface AgentIdentity {
  /** Display name the agent goes by. */
  name: string;
  /** Optional extra persona/behavior lines appended to the base prompt. */
  persona?: string;
}

const DEFAULT_IDENTITY: AgentIdentity = { name: "Scooter" };

/** The base identity/behavior prompt, independent of any skill. */
export function identityPrompt(id: AgentIdentity = DEFAULT_IDENTITY): string {
  return [
    `You are ${id.name}, an AI coding agent.`,
    `Refer to yourself as ${id.name}. When asked your name, say you are ${id.name}.`,
    `You work inside a per-conversation Nix sandbox: a Linux environment where`,
    `your shell commands run. Packages are managed with Nix (see the skills`,
    `below if present). Be concise and act directly — run commands to inspect and`,
    `change the workspace rather than guessing.`,
    // Tool routing caveat: only the developer extension's read/write/edit/shell
    // tools run in the sandbox. The `tree` and `read_image` tools do NOT — they
    // read the host's filesystem, not yours, so their output is misleading. We
    // can't disable them on this goose version, so avoid them by instruction:
    `IMPORTANT: do NOT use the \`tree\` or \`read_image\` tools — they read a`,
    `different machine's filesystem, not your sandbox, so their results are wrong.`,
    `To list or explore directories, use the \`shell\` tool with \`ls\`, \`ls -R\`,`,
    `or \`find\` instead — those run in your sandbox and see the real workspace.`,
    // Conversation titling: the host extracts a <title>…</title> marker from the
    // very start of your reply and uses it to name the conversation, then strips
    // it from what the user sees.
    `At the very START of your FIRST reply in a conversation, emit a concise`,
    `(3–6 word) title for the task wrapped in a <title> tag, e.g.`,
    `"<title>Fix the login redirect</title>". Put it before anything else and do`,
    `it only once, on the first reply. The tag is hidden from the user.`,
    id.persona ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A loaded skill: its name (from filename) and full markdown text. */
export interface Skill {
  name: string;
  text: string;
}

/** Read every `*.md` skill from `dir` (sorted by name; missing dir -> []). */
export function loadSkills(dir: string): Skill[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f.replace(/\.md$/, ""), text: readFileSync(join(dir, f), "utf8") }));
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

/** Drop a leading `---\n...\n---` YAML frontmatter block, keeping the body. */
function stripFrontmatter(md: string): string {
  const m = md.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? md.slice(m[0].length) : md;
}
