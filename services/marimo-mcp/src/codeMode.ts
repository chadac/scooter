/**
 * Snippet builders for marimo's `marimo._code_mode` cell API. These return PYTHON
 * source that we run through the scratchpad execute endpoint — i.e. structural cell
 * ops (create / run a named cell) are driven from inside the kernel via
 * `cm.get_context()`, since there is no HTTP endpoint for them.
 *
 * The code-mode surface shipped in marimo v0.21.1 and is UNSTABLE (marimo issue
 * #4345 is open; the marimo-pair "code-mode-surface" reference calls it a
 * point-in-time snapshot). All of that risk is contained in this one file: the
 * snippets are small, print a machine-readable result line, and are easy to update
 * if the API moves. See types.ts MARIMO_MIN_CODE_MODE_VERSION.
 */

/** Python-literal-escape a string for embedding in a triple-quoted block. We wrap
 *  user code in a triple-quoted string, so only backslashes and the triple-quote
 *  need escaping. */
function pyTripleQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

/** A marker the snippets print so the tool layer can distinguish an operation's own
 *  success/JSON from arbitrary notebook stdout. */
export const CODE_MODE_MARKER = "__SCOOTER_MARIMO__";

/** create_cell(code) — add a new cell to the notebook graph (does NOT auto-run;
 *  marimo's create_cell is structural). Optionally give it a name. Prints
 *  `<marker> {"ok":true,"cell_id":"..."}`. */
export function createCellSnippet(code: string, name?: string): string {
  const nameArg = name ? `, name=${JSON.stringify(name)}` : "";
  return `
import json as _json
import marimo._code_mode as _cm
async def _op():
    async with _cm.get_context() as ctx:
        # create_cell returns the CellId (a str) directly — NOT an object with
        # .cell_id (verified against the live marimo _code_mode API).
        return ctx.create_cell(r"""${pyTripleQuoted(code)}"""${nameArg})
_cid = await _op()
print("${CODE_MODE_MARKER} " + _json.dumps({"ok": True, "cell_id": str(_cid)}))
`.trim();
}

/** run_cell(target) — explicitly queue a cell for execution. create_cell/edit_cell
 *  are structural only, so a caller runs a cell after creating it. The API param is
 *  `target` (the cell id). */
export function runCellSnippet(cellId: string): string {
  return `
import json as _json
import marimo._code_mode as _cm
async def _op():
    async with _cm.get_context() as ctx:
        ctx.run_cell(${JSON.stringify(cellId)})
        return True
await _op()
print("${CODE_MODE_MARKER} " + _json.dumps({"ok": True, "cell_id": ${JSON.stringify(cellId)}}))
`.trim();
}

/** list_cells() — dump the notebook's cells (id + code + name). A NotebookCell
 *  exposes `.id` / `.name` / `.code` (verified live — NOT `.cell_id`). Prints
 *  `<marker> {"ok":true,"cells":[{"cell_id","name","code"}...]}`. */
export function listCellsSnippet(): string {
  return `
import json as _json
import marimo._code_mode as _cm
async def _op():
    async with _cm.get_context() as ctx:
        return [
            {"cell_id": str(getattr(c, "id", "")), "name": getattr(c, "name", None), "code": getattr(c, "code", None)}
            for c in ctx.cells
        ]
_cells = await _op()
print("${CODE_MODE_MARKER} " + _json.dumps({"ok": True, "cells": _cells}))
`.trim();
}

/** Parse the marker line out of an execute stdout. Returns the JSON object the
 *  snippet printed, or null if the marker isn't present (the op didn't complete —
 *  e.g. a code-mode API change threw before the print). */
export function parseCodeModeResult(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split("\n")) {
    const i = line.indexOf(CODE_MODE_MARKER);
    if (i === -1) continue;
    const json = line.slice(i + CODE_MODE_MARKER.length).trim();
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}
