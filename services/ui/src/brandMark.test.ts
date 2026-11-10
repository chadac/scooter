/**
 * Scooter has one mark, the 🛴 kick scooter (brandMark.ts). This scans the repo's source for
 * the motor scooter (U+1F6F5) in any of the encodings a favicon or a string would carry it
 * in, and for react-icons scooter glyphs, so a second mark cannot creep back in.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { SCOOTER_MARK } from "./brandMark.js";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const ROOTS = ["services", "contrib", "lib", "modules", "docs", "nix", "pkgs", "skills", "README.md"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "result", "__pycache__", ".venv", "build"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".html", ".css", ".py", ".nix", ".md", ".json", ".svg", ".go", ".yaml", ".yml"]);

// Built from parts so this file does not match itself.
const motor = String.fromCodePoint(0x1f6f5);
const FORBIDDEN: Array<[string, string]> = [
  ["the motor scooter emoji", motor],
  ["its URL encoding", "%F0%9F%9B%B" + "5"],
  ["its JS escape", "\\u{1F6F" + "5}"],
  ["its UTF-16 escape", "\\uD83D\\uDEF" + "5"],
  ["its HTML entity", "&#x1F6F" + "5;"],
  ["its decimal HTML entity", "&#12875" + "7;"],
  ["a react-icons scooter glyph", "MdElectric" + "Scooter"],
  ["a react-icons moped glyph", "Md" + "Moped"],
];

function* files(path: string): Generator<string> {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (SKIP_DIRS.has(name)) continue;
      yield* files(join(path, name));
    }
  } else if (TEXT_EXT.has(extname(path).toLowerCase()) && st.size < 2_000_000) {
    yield path;
  }
}

describe("one Scooter mark", () => {
  it("is the kick scooter", () => {
    expect(SCOOTER_MARK).toBe(String.fromCodePoint(0x1f6f4));
  });

  it("no source file uses the motor scooter or another scooter glyph", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(REPO, root))) {
        const text = readFileSync(f, "utf8");
        for (const [what, needle] of FORBIDDEN) {
          if (text.toLowerCase().includes(needle.toLowerCase())) hits.push(`${relative(REPO, f)}: ${what}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("every favicon uses the kick scooter", () => {
    const kick = "%F0%9F%9B%B4";
    for (const f of ["services/ui/index.html", "modules/sandbox-os/web-services/chat-page/index.html", "contrib/web-review/review/static/shell.html", "contrib/shares/scooter_contrib_shares/transport.py"]) {
      expect(readFileSync(join(REPO, f), "utf8"), f).toContain(kick);
    }
  });
});
