// Unproxied agent-host prefixes fall through to the SPA's index.html.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UI = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__fixtures__" ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

// First path segment after the agent-host base, e.g. /user-hooks.
function fetchedPrefixes(): Set<string> {
  const url = /\$\{(?:[\w.]*baseUrl(?:\.replace\(\/\\\/\$\/, ""\))?|(?:this\.)?base)\}\/([a-z][a-z-]*)/g;
  const found = new Set<string>();
  for (const f of sources(join(UI, "src"))) {
    for (const m of readFileSync(f, "utf8").matchAll(url)) found.add(`/${m[1]}`);
  }
  return found;
}

function viteProxied(): string[] {
  const text = readFileSync(join(UI, "vite.config.ts"), "utf8");
  const list = text.match(/\[((?:\s*"\/[^"]+",?)+)\s*\]\.map/);
  if (!list) throw new Error("vite.config.ts proxy prefix list not found");
  return [...list[1].matchAll(/"(\/[^"]+)"/g)].map((m) => m[1]);
}

function nginxProxied(): string[] {
  const text = readFileSync(join(UI, "image", "nginx.nix"), "utf8");
  // `location /` is the SPA fallback, so it covers nothing.
  return [...text.matchAll(/^\s*location\s+(\/[^\s{]*)\s*\{/gm)].map((m) => m[1]).filter((l) => l !== "/");
}

const covers = (locations: string[], prefix: string) =>
  locations.some((l) => prefix === l.replace(/\/$/, "") || prefix.startsWith(l.endsWith("/") ? l : `${l}/`));

describe("agent-host API proxies", () => {
  const prefixes = [...fetchedPrefixes()].sort();

  it("finds the UI's agent-host calls", () => {
    expect(prefixes).toEqual(expect.arrayContaining(["/conversations", "/user-hooks", "/user-skills"]));
  });

  it.each(prefixes)("nginx proxies %s", (p) => {
    expect(covers(nginxProxied(), p), `add a location ${p} to image/nginx.nix`).toBe(true);
  });

  it.each(prefixes)("the vite dev server proxies %s", (p) => {
    expect(covers(viteProxied(), p), `add "${p}" to vite.config.ts's proxy list`).toBe(true);
  });
});
