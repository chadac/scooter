/**
 * Syntax highlighting for fenced code blocks in the thread's markdown
 * (components/assistant-ui/syntax-highlighter.tsx, which loads this module lazily so
 * the grammars stay out of the initial bundle).
 *
 * lowlight runs highlight.js over the code and returns a hast tree, so the colouring is
 * synchronous (a streaming block is coloured on every token with no flash) and never goes
 * through innerHTML. The grammar set is the languages a coding agent here writes:
 * python, c, cpp, rust, javascript, typescript, json, bash, shell, sql, go, java, yaml,
 * xml/html, css, markdown, diff, makefile, ini/toml, nix, dockerfile. highlight.js
 * aliases (`py`, `js`, `jsx`, `ts`, `tsx`, `sh`, `zsh`, `c++`, `yml`, `html`, `console`,
 * `toml`) resolve through the registry. A language nobody registered, or a block too
 * large to colour cheaply, returns null and the caller shows plain text.
 */

import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nix from "highlight.js/lib/languages/nix";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const lowlight = createLowlight({
  bash,
  c,
  cpp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  makefile,
  markdown,
  nix,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
});

export type HighlightTree = ReturnType<typeof lowlight.highlight>;

/** Above this many characters a block stays plain: highlighting re-runs on every streamed token. */
export const MAX_HIGHLIGHT_CHARS = 100_000;

/** Fence labels that mean "no language": leave them plain rather than guess. */
const PLAIN = new Set(["", "unknown", "text", "txt", "plain", "plaintext", "none", "output", "log"]);

/** The highlight.js name a fence label resolves to, or undefined when it is plain or unknown. */
export function highlightLanguage(language: string | undefined): string | undefined {
  const lang = language?.trim().toLowerCase() ?? "";
  if (PLAIN.has(lang)) return undefined;
  return lowlight.registered(lang) ? lang : undefined;
}

/** The highlighted hast tree for `code`, or null to render it plain. */
export function highlightCode(language: string | undefined, code: string): HighlightTree | null {
  const lang = highlightLanguage(language);
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    return lowlight.highlight(lang, code);
  } catch {
    return null;
  }
}

/** The registered language names (not aliases), for tests and the docs. */
export function highlightLanguages(): string[] {
  return lowlight.listLanguages();
}
