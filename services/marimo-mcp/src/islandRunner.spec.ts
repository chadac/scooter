/** Unit — generateIsland over a fake exec: runs uv-run-python with the marimo env,
 *  parses the island, and errors cleanly on failure. */

import { describe, it, expect, vi } from "vitest";

import { generateIsland, type IslandExec, type IslandUvConfig } from "./islandRunner.js";
import { ISLAND_MARKER } from "./island.js";
import { MarimoError } from "./types.js";

const uv: IslandUvConfig = {
  uvBin: "/nix/store/x-uv/bin/uv",
  env: { UV_PYTHON: "/nix/store/y-python/bin/python3.14", UV_PYTHON_DOWNLOADS: "never" },
};

const okStdout = (island = "<marimo-island>c</marimo-island>", head = "<script></script>") =>
  `resolving...\n${ISLAND_MARKER} ${JSON.stringify({ islandHtml: island, headHtml: head })}\n`;

function fakeExec(over: Partial<ReturnType<IslandExec["execute"]> extends Promise<infer T> ? T : never> = {}, capture?: (req: { command: string; args?: string[] }) => void): IslandExec {
  return {
    execute: vi.fn(async (req) => {
      capture?.(req);
      return { stdout: okStdout(), stderr: "", exitCode: 0, ...over };
    }),
  };
}

describe("generateIsland", () => {
  it("runs `env <UV env> uv run --with marimo python -c <script>` and parses the island", async () => {
    let seen: { command: string; args?: string[] } | undefined;
    const exec = fakeExec({}, (r) => (seen = r));
    const island = await generateIsland(exec, uv, "import marimo as mo\nmo.md('hi')", "My chart");

    expect(island).toMatchObject({ islandHtml: expect.stringContaining("<marimo-island>"), headHtml: expect.stringContaining("<script>"), title: "My chart" });
    // env-prefixed uv invocation with the pinned python + downloads off.
    expect(seen?.command).toBe("env");
    expect(seen?.args?.slice(0, 2)).toEqual(["UV_PYTHON=/nix/store/y-python/bin/python3.14", "UV_PYTHON_DOWNLOADS=never"]);
    expect(seen?.args).toContain("/nix/store/x-uv/bin/uv");
    expect(seen?.args).toContain("--with");
    expect(seen?.args).toContain("marimo");
    // the last arg is the generator script
    expect(seen?.args?.at(-1)).toContain("MarimoIslandGenerator");
  });

  it("throws MarimoError on a non-zero exit (surfacing stderr)", async () => {
    const exec = fakeExec({ exitCode: 1, stderr: "ModuleNotFoundError: marimo", stdout: "" });
    await expect(generateIsland(exec, uv, "x")).rejects.toBeInstanceOf(MarimoError);
    await expect(generateIsland(exec, uv, "x")).rejects.toThrow(/island generation failed/i);
  });

  it("throws when the output has no island marker (marimo errored mid-render)", async () => {
    const exec = fakeExec({ exitCode: 0, stdout: "some warning but no marker", stderr: "" });
    await expect(generateIsland(exec, uv, "x")).rejects.toThrow(/no island/i);
  });
});
