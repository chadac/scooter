/** Unit — the code-mode snippet builders + marker parser. */

import { describe, it, expect } from "vitest";

import { createCellSnippet, runCellSnippet, listCellsSnippet, parseCodeModeResult, CODE_MODE_MARKER } from "./codeMode.js";

describe("code-mode snippets", () => {
  it("createCellSnippet embeds the user code in a triple-quoted block + prints the marker", () => {
    const s = createCellSnippet("import polars as pl\npl.DataFrame({'a':[1]})", "load");
    expect(s).toContain("marimo._code_mode");
    expect(s).toContain("ctx.create_cell(");
    expect(s).toContain('name="load"');
    expect(s).toContain(CODE_MODE_MARKER);
    expect(s).toContain("import polars as pl");
  });

  it("createCellSnippet escapes an embedded triple-quote so it can't break out", () => {
    const s = createCellSnippet('x = """nested"""');
    // The literal triple-quote must be escaped inside the r"""...""" wrapper.
    expect(s).toContain('\\"\\"\\"nested\\"\\"\\"');
  });

  it("runCellSnippet targets the cell id", () => {
    const s = runCellSnippet("cell-abc");
    expect(s).toContain('ctx.run_cell("cell-abc")');
    expect(s).toContain(CODE_MODE_MARKER);
  });

  it("listCellsSnippet dumps cell id/name/code", () => {
    const s = listCellsSnippet();
    expect(s).toContain("ctx.cells");
    expect(s).toContain("cell_id");
  });
});

describe("parseCodeModeResult", () => {
  it("extracts the JSON after the marker", () => {
    const stdout = `some notebook noise\n${CODE_MODE_MARKER} {"ok":true,"cell_id":"c1"}\n`;
    expect(parseCodeModeResult(stdout)).toEqual({ ok: true, cell_id: "c1" });
  });

  it("returns null when the marker is absent (op didn't complete)", () => {
    expect(parseCodeModeResult("Traceback (most recent call last): ...")).toBeNull();
  });

  it("returns null when the marker line isn't valid JSON", () => {
    expect(parseCodeModeResult(`${CODE_MODE_MARKER} not-json`)).toBeNull();
  });
});
