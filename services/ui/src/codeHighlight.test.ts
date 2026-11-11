/**
 * Fenced-code highlighting (codeHighlight.ts): the common languages tokenize, highlight.js
 * aliases resolve, and anything unknown or plain falls back to null so the block renders as
 * raw text.
 */

import { describe, it, expect } from "vitest";

import { highlightCode, highlightLanguage, highlightLanguages, MAX_HIGHLIGHT_CHARS, type HighlightTree } from "./codeHighlight.js";

/** Every `hljs-*` class in the tree, in document order. */
function tokenClasses(tree: HighlightTree | null): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    const n = node as { type?: string; properties?: { className?: unknown }; children?: unknown[] };
    if (n.type === "element") {
      const cls = n.properties?.className;
      if (Array.isArray(cls)) out.push(...cls.map(String));
    }
    for (const c of n.children ?? []) walk(c);
  };
  if (tree) walk(tree);
  return out;
}

/** The text of the tree, to check tokenizing loses nothing. */
function textOf(tree: HighlightTree | null): string {
  let s = "";
  const walk = (node: unknown) => {
    const n = node as { type?: string; value?: string; children?: unknown[] };
    if (n.type === "text") s += n.value ?? "";
    for (const c of n.children ?? []) walk(c);
  };
  if (tree) walk(tree);
  return s;
}

describe("highlightCode", () => {
  const samples: [string, string, string][] = [
    ["python", "def area(r):\n    return 3.14 * r ** 2  # circle\n", "hljs-keyword"],
    ["cpp", "#include <vector>\nint main() {\n  std::vector<int> v{1, 2};\n  return 0;\n}\n", "hljs-keyword"],
    ["rust", 'fn main() {\n    let x: u32 = 1;\n    println!("{}", x);\n}\n', "hljs-keyword"],
    ["javascript", "const add = async (a, b) => {\n  return a + b;\n};\n", "hljs-keyword"],
    ["typescript", "interface Point {\n  x: number;\n}\n", "hljs-keyword"],
    ["bash", 'for f in *.txt; do echo "$f"; done\n', "hljs-keyword"],
    ["json", '{"name": "scooter", "ok": true}\n', "hljs-attr"],
    ["nix", "{ pkgs, ... }: { environment.systemPackages = [ pkgs.git ]; }\n", "hljs-attr"],
    ["dockerfile", "FROM alpine\nRUN apk add git\n", "hljs-keyword"],
  ];

  it.each(samples)("tokenizes %s", (language, code, expectedClass) => {
    const tree = highlightCode(language, code);
    expect(tree).not.toBeNull();
    const classes = tokenClasses(tree);
    expect(classes.length).toBeGreaterThan(0);
    // highlight.js scopes are `hljs-<scope>`, with a bare modifier (`function_`) after a title.
    expect(classes.filter((c) => c.startsWith("hljs-")).length).toBeGreaterThan(0);
    expect(classes).toContain(expectedClass);
    // Tokenizing re-wraps the text; it must not alter it.
    expect(textOf(tree)).toBe(code);
  });

  it.each(["py", "js", "jsx", "ts", "tsx", "sh", "zsh", "console", "c++", "yml", "html", "toml", "Python"])(
    "resolves the alias %s",
    (alias) => {
      expect(highlightLanguage(alias)).toBe(alias.toLowerCase());
      expect(highlightCode(alias, "x = 1\n")).not.toBeNull();
    },
  );

  it.each(["", "unknown", "text", "plaintext", "output", "no-such-language", "   "])(
    "leaves %j plain",
    (language) => {
      expect(highlightLanguage(language)).toBeUndefined();
      expect(highlightCode(language, "x = 1")).toBeNull();
    },
  );

  it("leaves a missing language plain", () => {
    expect(highlightCode(undefined, "x = 1")).toBeNull();
  });

  it("leaves an oversized block plain rather than re-highlighting it on every token", () => {
    const big = "x = 1\n".repeat(MAX_HIGHLIGHT_CHARS / 6 + 1);
    expect(big.length).toBeGreaterThan(MAX_HIGHLIGHT_CHARS);
    expect(highlightCode("python", big)).toBeNull();
    expect(highlightCode("python", big.slice(0, MAX_HIGHLIGHT_CHARS))).not.toBeNull();
  });

  it("registers the languages a coding agent writes most", () => {
    const langs = highlightLanguages();
    for (const l of ["python", "cpp", "c", "rust", "javascript", "typescript", "go", "java", "bash", "json", "yaml", "sql", "nix", "dockerfile", "markdown", "diff"]) {
      expect(langs, l).toContain(l);
    }
    // A curated set, not highlight.js's `common`: the grammars are a third of the chunk.
    expect(langs.length).toBeLessThanOrEqual(24);
    expect(langs).not.toContain("swift");
  });
});
