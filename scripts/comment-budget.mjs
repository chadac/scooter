#!/usr/bin/env node
// Comment budget: ONE sentence, TEN words, per comment. Flags only ADDED comment lines.
//   node comment-budget.mjs <base-ref>

import { execSync } from "node:child_process";

const base = process.argv[2] ?? "origin/main";
const MAX_WORDS = 10;

const diff = execSync(`git diff ${base} -- '*.ts' '*.go' '*.mjs' '*.nix'`, {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

function prose(line) {
  let t = line.replace(/^\+/, "").trim();
  t = t.replace(/\s*\*\/$/, "").trim();
  if (t === "/*" || t === "/**" || t === "*/" || t === "*" || t === "//" || t === "#") return "";
  for (const m of ["///", "//", "/**", "*", "#"]) {
    if (t.startsWith(m + " ")) return t.slice(m.length + 1).trim();
  }
  return null;
}

const violations = [];
let file = null;
let block = [];
let newLine = 0;

function flush() {
  if (!block.length) return;
  const text = block.map((b) => b.text).filter(Boolean).join(" ").trim();
  const at = block[0].line;
  block = [];
  if (!text) return;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  const words = text.split(/\s+/).filter(Boolean).length;
  if (sentences.length > 1) violations.push(`${file}:${at}: ${sentences.length} sentences — ${text.slice(0, 64)}…`);
  else if (words > MAX_WORDS) violations.push(`${file}:${at}: ${words} words — ${text.slice(0, 64)}…`);
}

for (const line of diff.split("\n")) {
  if (line.startsWith("+++ b/")) { flush(); file = line.slice(6); continue; }
  if (line.startsWith("@@")) { flush(); newLine = Number(/\+(\d+)/.exec(line)?.[1] ?? 0) - 1; continue; }
  if (line.startsWith("-")) continue;
  if (line.startsWith("+") || line.startsWith(" ")) newLine++;
  if (!line.startsWith("+")) { flush(); continue; }
  const p = prose(line);
  if (p === null) { flush(); continue; }
  block.push({ text: p, line: newLine });
}
flush();

if (violations.length) {
  console.error(`${violations.length} violation(s) — one sentence, ${MAX_WORDS} words, per comment\n`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("comment budget: clean");
