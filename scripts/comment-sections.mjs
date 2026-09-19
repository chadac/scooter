#!/usr/bin/env node
// comment-sections.mjs — merge one target's verdict into the SHARED flake-focus
// PR comment, so `flake focus` (fast) and `flake focus full` (k3d) report into a
// single comment instead of two competing ones.
//
// A PR fixing a flake often carries both labels, and the two answers only mean
// something TOGETHER: a green fast run is evidence of no regression, while the
// full run is the evidence that the flake is actually fixed. Split across two
// comments a reader sees whichever GitHub renders last and treats it as "the"
// verdict. One comment, one section per target, each job owning its own section:
//
//   <!-- flake-focus-report -->
//   ## Flake focus
//   <!-- flake-focus:fast:start -->  …fast verdict…  <!-- flake-focus:fast:end -->
//   <!-- flake-focus:full:start -->  …full verdict…  <!-- flake-focus:full:end -->
//
// Usage:
//   node scripts/comment-sections.mjs --section fast --new body.md [--existing old.md]
//     --existing omitted (or an empty/absent file) => a fresh comment.
//     Output: the merged comment body on stdout.
//   node scripts/comment-sections.mjs --section fast --new body.md --check posted.md
//     Exit 0 if `posted.md` carries exactly that section (our write survived),
//     1 if it does not (a racing job clobbered it — the caller retries).

import { readFileSync } from "node:fs";

export const MARKER = "<!-- flake-focus-report -->";
export const HEADING = "## Flake focus";
/** Fixed render order, so the comment doesn't reshuffle depending on which job finished first. */
export const ORDER = ["fast", "full"];

export const startTag = (id) => `<!-- flake-focus:${id}:start -->`;
export const endTag = (id) => `<!-- flake-focus:${id}:end -->`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pull the existing per-target sections out of a comment body. */
export function parseSections(body) {
  const sections = new Map();
  if (!body) return sections;
  // Any id, not just ORDER: an unknown section (an older or newer target) must
  // survive a merge rather than be silently dropped by this job.
  const re = /<!-- flake-focus:([a-z0-9-]+):start -->\n?([\s\S]*?)\n?<!-- flake-focus:\1:end -->/g;
  for (const m of body.matchAll(re)) sections.set(m[1], m[2].trim());
  return sections;
}

export function renderComment(sections) {
  const ids = [...ORDER.filter((id) => sections.has(id)), ...[...sections.keys()].filter((id) => !ORDER.includes(id))];
  const blocks = ids.map((id) => `${startTag(id)}\n${sections.get(id)}\n${endTag(id)}`);
  return [MARKER, "", HEADING, "", blocks.join("\n\n"), ""].join("\n");
}

/**
 * Replace (or add) one target's section, leaving every other section untouched.
 *
 * Read-modify-write on a shared comment: the two jobs can finish close together,
 * so the caller re-reads and re-applies if its section did not survive (see
 * sticky-comment.sh). Keeping this function pure makes that retry trivial.
 */
export function mergeSection(existing, id, content) {
  const sections = parseSections(existing);
  sections.set(id, content.trim());
  return renderComment(sections);
}

/** True when `body` already carries exactly this section content (post-write check). */
export function hasSection(body, id, content) {
  const re = new RegExp(`${escapeRe(startTag(id))}\\n?([\\s\\S]*?)\\n?${escapeRe(endTag(id))}`);
  const m = re.exec(body || "");
  return !!m && m[1].trim() === content.trim();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++)
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.section || !args.new) {
    console.error("usage: comment-sections.mjs --section <id> --new <body.md> [--existing <old.md>]");
    process.exit(2);
  }
  const read = (f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  if (args.check) {
    process.exit(hasSection(read(args.check), args.section, read(args.new)) ? 0 : 1);
  }
  process.stdout.write(mergeSection(args.existing ? read(args.existing) : "", args.section, read(args.new)));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
