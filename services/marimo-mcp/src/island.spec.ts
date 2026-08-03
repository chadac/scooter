/** Unit — the island script generator + output parser (pure). */

import { describe, it, expect } from "vitest";

import { islandGenScript, parseIslandOutput, ISLAND_MARKER } from "./island.js";

describe("islandGenScript", () => {
  it("uses MarimoIslandGenerator + add_code + render (NO build) and prints the marker", () => {
    const s = islandGenScript("import marimo as mo\nmo.md('hi')");
    expect(s).toContain("MarimoIslandGenerator");
    expect(s).toContain("add_code(");
    expect(s).toContain(".render()");
    expect(s).toContain("render_head()");
    expect(s).not.toContain(".build("); // no kernel
    expect(s).toContain(ISLAND_MARKER);
    expect(s).toContain("import marimo as mo");
  });

  it("escapes an embedded triple-quote so it can't break the r\"\"\" wrapper", () => {
    const s = islandGenScript('x = """nested"""');
    expect(s).toContain('\\"\\"\\"nested\\"\\"\\"');
  });
});

describe("parseIslandOutput", () => {
  const line = (obj: unknown) => `${ISLAND_MARKER} ${JSON.stringify(obj)}`;

  it("extracts islandHtml + headHtml from the marker line", () => {
    const stdout = `some uv noise\n${line({ islandHtml: "<marimo-island>x</marimo-island>", headHtml: "<script></script>" })}\n`;
    expect(parseIslandOutput(stdout)).toEqual({
      islandHtml: "<marimo-island>x</marimo-island>",
      headHtml: "<script></script>",
      title: undefined,
    });
  });

  it("carries the title through", () => {
    const stdout = line({ islandHtml: "<i>", headHtml: "<h>" });
    expect(parseIslandOutput(stdout, "My chart")?.title).toBe("My chart");
  });

  it("returns null when the marker is absent", () => {
    expect(parseIslandOutput("Traceback: boom")).toBeNull();
  });

  it("returns null when the payload is missing a field", () => {
    expect(parseIslandOutput(line({ islandHtml: "<i>" }))).toBeNull();
  });

  it("returns null on non-JSON after the marker", () => {
    expect(parseIslandOutput(`${ISLAND_MARKER} not-json`)).toBeNull();
  });
});
