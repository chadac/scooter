/**
 * The marimo notebook TOOLS as pure handlers over a MarimoClient — the MCP layer
 * (index.ts) just wraps these with Zod schemas. Kept HTTP/MCP-free so they're
 * unit-testable against a fake client.
 *
 * The stable workhorse is `marimo_execute` (scratchpad). The cell tools
 * (`marimo_create_cell`, `marimo_run_cell`, `marimo_list_cells`) drive the
 * version-pinned `marimo._code_mode` API by executing a snippet through the same
 * scratchpad — see codeMode.ts.
 */

import type { MarimoClient } from "./client.js";
import { MarimoError } from "./types.js";
import { createCellSnippet, runCellSnippet, listCellsSnippet, parseCodeModeResult } from "./codeMode.js";

/** The MCP tool-result shape (mirrors agent-host's ToolResult). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Turn any thrown error into an isError ToolResult with a helpful, actionable
 *  message (MarimoError carries a `kind` we can phrase around). */
function toErrorResult(e: unknown): ToolResult {
  if (e instanceof MarimoError) {
    switch (e.kind) {
      case "no-session":
        return err(`No marimo notebook is open. Start marimo (scooter-service start marimo) and open it, then retry. (${e.message})`);
      case "multiple-sessions":
        return err(`${e.message} — pass \`file\` to target one.`);
      case "unreachable":
        return err(`Couldn't reach the marimo server — the sandbox may be asleep or marimo isn't started yet. (${e.message})`);
      case "incomplete-stream":
        return err(`${e.message}`);
      default:
        return err(`marimo error: ${e.message}`);
    }
  }
  return err(`marimo error: ${e instanceof Error ? e.message : String(e)}`);
}

export interface MarimoTools {
  listSessions(): Promise<ToolResult>;
  execute(args: { code: string; file?: string; session?: string }): Promise<ToolResult>;
  createCell(args: { code: string; name?: string; run?: boolean; file?: string; session?: string }): Promise<ToolResult>;
  runCell(args: { cell_id: string; file?: string; session?: string }): Promise<ToolResult>;
  listCells(args: { file?: string; session?: string }): Promise<ToolResult>;
}

/** Build the tool handlers over a client. `client` is per-conversation (its target
 *  is the conversation's pod marimo) — the MCP layer constructs one per request. */
export function createMarimoTools(client: MarimoClient): MarimoTools {
  const sel = (a: { file?: string; session?: string }) => ({ file: a.file, sessionId: a.session });

  /** Run a code-mode snippet + surface its marker result (or the raw stderr if the
   *  op threw inside the kernel — e.g. a code-mode API drift). Returns the parsed
   *  marker object (or null) alongside the ToolResult so callers can chain (e.g.
   *  create → run) without re-parsing rendered text. */
  async function runCodeMode(
    snippet: string,
    sel: { file?: string; sessionId?: string },
    label: string,
  ): Promise<{ result: ToolResult; parsed: Record<string, unknown> | null }> {
    const r = await client.execute(snippet, sel);
    const parsed = parseCodeModeResult(r.stdout);
    if (!r.success || !parsed?.ok) {
      const detail = r.stderr.trim() || r.stdout.trim() || "(no output)";
      return { result: err(`${label} failed. marimo output:\n${detail}`), parsed: null };
    }
    return { result: ok(`${label} ok: ${JSON.stringify(parsed)}`), parsed };
  }

  return {
    async listSessions() {
      try {
        const sessions = await client.listSessions();
        const entries = Object.entries(sessions).map(([id, info]) => ({ id, path: info.path ?? info.filename ?? null }));
        if (entries.length === 0) return ok("No marimo notebooks are open.");
        return ok(`Open marimo notebooks:\n${entries.map((e) => `- ${e.id}${e.path ? `  (${e.path})` : ""}`).join("\n")}`);
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async execute(args) {
      try {
        const r = await client.execute(args.code, sel(args));
        const parts: string[] = [];
        if (r.stdout) parts.push(r.stdout.replace(/\n$/, ""));
        if (r.output) parts.push(`=> ${r.output}`);
        if (!r.success) parts.push(`\n[error]\n${r.stderr.trim()}`);
        return r.success ? ok(parts.join("\n") || "(no output)") : err(parts.join("\n") || "(execution failed)");
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async createCell(args) {
      try {
        const created = await runCodeMode(createCellSnippet(args.code, args.name), sel(args), "create_cell");
        if (created.result.isError || !args.run) return created.result;
        // Optionally run the freshly-created cell (create_cell is structural only).
        const cellId = created.parsed?.cell_id;
        if (typeof cellId !== "string") return created.result; // no id recovered — leave it created, not run
        const ran = await runCodeMode(runCellSnippet(cellId), sel(args), "run_cell");
        return ran.result.isError ? ran.result : ok(`create_cell + run ok: cell_id=${cellId}`);
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async runCell(args) {
      try {
        return (await runCodeMode(runCellSnippet(args.cell_id), sel(args), "run_cell")).result;
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async listCells(args) {
      try {
        return (await runCodeMode(listCellsSnippet(), sel(args), "list_cells")).result;
      } catch (e) {
        return toErrorResult(e);
      }
    },
  };
}
