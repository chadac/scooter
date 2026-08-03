/**
 * marimo ISLAND generation — the WASM-embed path. Produces a self-contained
 * `<marimo-island>` for a snippet of code that runs in the BROWSER via WASM (no
 * running notebook, no session, no kernel). Verified against marimo 0.23.6:
 *
 *   g = MarimoIslandGenerator()
 *   stub = g.add_code(<code>)
 *   stub.render()        -> the <marimo-island> HTML (NO build() / kernel needed)
 *   g.render_head()      -> the <script>/<link> head assets (islands main.js + CSS)
 *
 * We DON'T call build() — build() spawns a marimo kernel subprocess that fails in the
 * uv-managed sandbox. The no-build render path is reliable; the cell executes
 * client-side in pyodide. See the marimo-embed design.
 *
 * This module is PURE: it emits the python SOURCE to run (islandGenScript) and parses
 * the result (parseIslandOutput). The agent-host runs the script via a pod exec (uv
 * run python), since island generation must run in the pod's marimo env — NOT through
 * the session-requiring /api/kernel/execute path.
 */

/** A marker the script prints so we can separate our JSON payload from any other
 *  stdout uv/marimo emit (resolver noise, warnings). */
export const ISLAND_MARKER = "__SCOOTER_MARIMO_ISLAND__";

/** The generated embed: the island HTML (goes inline in the chat) + the head assets
 *  (the islands runtime <script>/<link>, injected into <head> ONCE per page). */
export interface IslandResult {
  /** The `<marimo-island>...</marimo-island>` element. */
  islandHtml: string;
  /** The `<script type="module" ...islands.../main.js">` + stylesheet `<link>` to
   *  load once in the document head so the island hydrates. */
  headHtml: string;
  /** An optional human title the agent gave the embed (rendered above the island). */
  title?: string;
}

/** Python source that generates ONE island from `code` and prints
 *  `<marker> {"islandHtml": "...", "headHtml": "..."}` as a single JSON line.
 *  `code` is embedded as a triple-quoted string (escaped), like codeMode.ts. */
export function islandGenScript(code: string): string {
  const escaped = code.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
  return `
import json as _json
from marimo import MarimoIslandGenerator as _G
_g = _G()
_stub = _g.add_code(r"""${escaped}""")
# No build() — render the island directly (runs in the browser via WASM).
_island = _stub.render()
_head = _g.render_head()
print("${ISLAND_MARKER} " + _json.dumps({"islandHtml": _island, "headHtml": _head}))
`.trim();
}

/** Parse the marker line out of the script's stdout into an IslandResult, or null if
 *  the marker/JSON isn't present (generation failed — the caller surfaces stderr). */
export function parseIslandOutput(stdout: string, title?: string): IslandResult | null {
  for (const line of stdout.split("\n")) {
    const i = line.indexOf(ISLAND_MARKER);
    if (i === -1) continue;
    try {
      const o = JSON.parse(line.slice(i + ISLAND_MARKER.length).trim()) as {
        islandHtml?: unknown;
        headHtml?: unknown;
      };
      if (typeof o.islandHtml !== "string" || typeof o.headHtml !== "string") return null;
      return { islandHtml: o.islandHtml, headHtml: o.headHtml, title };
    } catch {
      return null;
    }
  }
  return null;
}
