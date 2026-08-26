/**
 * In-process MCP server exposing sandbox-routed bash/read/write/edit tools to the
 * Claude Agent SDK.
 *
 * This is the crux of the SDK-backed `claude-code` provider: claude's OWN built-in
 * Bash/Read/Edit/Write run in the agent-host pod (the bug). We DISABLE those and
 * redirect them (via the SDK's `toolAliases` + `disallowedTools`) to THESE tools,
 * whose handlers call the per-conversation `ExecBackend` → exec IN THE SANDBOX pod.
 * So `scooter-rebuild` (which lives in the sandbox) is finally reachable, while
 * subscription auth is preserved (the SDK still spawns the same `claude` CLI).
 *
 * The pure handlers (sandboxToolHandlers) take an ExecBackend and return the MCP
 * CallToolResult shape — testable with a fake ExecBackend, no SDK runtime. The SDK
 * wiring (createSandboxMcpServer) is a thin wrapper that registers them; it imports
 * the SDK lazily so this module (and its tests) load without the SDK package.
 */

import type { ExecBackend } from "./types.js";

/** The MCP CallToolResult shape (a subset of @modelcontextprotocol/sdk's type —
 *  redeclared locally so the pure handlers don't depend on the SDK at type time). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Tool names registered under the server. The SDK exposes them to the model as
 *  `mcp__sandbox__<name>` (server name "sandbox" — see createSandboxMcpServer). The
 *  built-in→alias map redirects claude's Bash/Read/Edit/Write onto these. */
export const SANDBOX_SERVER_NAME = "sandbox";
export const TOOL_ALIASES: Record<string, string> = {
  Bash: "mcp__sandbox__bash",
  Read: "mcp__sandbox__read",
  Edit: "mcp__sandbox__edit",
  Write: "mcp__sandbox__write",
  // Searching the workspace is table stakes: without these the agent can only read
  // files it can already name. They were previously UNWIRED, so the model could call
  // the local built-ins and hang the turn on a permission prompt (see toolPolicy.ts).
  Glob: "mcp__sandbox__glob",
  Grep: "mcp__sandbox__grep",
};
/** The built-in tools we disable so the model can't run them locally. */
export const DISABLED_BUILTINS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];

/** The agent's work happens in the sandbox workspace. goose's ACP createTerminal
 *  uses the same default: run under /workspace unless an absolute /workspace path
 *  is given (a cwd in the agent-host pod doesn't exist in the sandbox). */
const DEFAULT_CWD = "/workspace";
function sandboxCwd(cwd?: string): string {
  return cwd && cwd.startsWith("/workspace") ? cwd : DEFAULT_CWD;
}

/** Output caps: a repo-wide search can return tens of thousands of lines, which would
 *  bury the model's context and stall the turn. The tool descriptions tell the model
 *  results may be capped, so a truncated list is not mistaken for a complete one. */
const GLOB_MAX = 300;
const GREP_MAX = 200;

/** Single-quote a value for `sh -lc`. */
const shq = (v: string): string => "'" + v.replace(/'/g, "'\\''") + "'";

/** Translate a glob (`**\/*.ts`, `src/*.py`) into an anchored ERE for grep. */
function globToRegex(pattern: string): string {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(/\*\*\//g, "(.*/)?").replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$";
}

/** Run a shell snippet in the sandbox and return its combined output. */
async function runCapture(exec: ExecBackend, script: string): Promise<string> {
  const handle = exec.spawn({ command: "sh", args: ["-lc", script], cwd: DEFAULT_CWD, env: {} });
  let out = "";
  handle.onOutput((c) => {
    out += c;
  });
  await handle.waitForExit();
  await handle.release();
  return out;
}
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * The pure tool handlers, bound to a conversation's ExecBackend. Each returns the
 * MCP CallToolResult. Testable against a fake ExecBackend without the SDK.
 */
export function sandboxToolHandlers(exec: ExecBackend) {
  return {
    /** bash: run a shell command in the sandbox; return combined output + exit note. */
    async bash(args: { command: string; cwd?: string }): Promise<ToolResult> {
      const command = (args?.command ?? "").trim();
      if (!command) return err("bash: no command provided");
      const handle = exec.spawn({ command: "sh", args: ["-lc", command], cwd: sandboxCwd(args?.cwd), env: {} });
      let out = "";
      handle.onOutput((chunk) => {
        out += chunk;
      });
      const { exitCode } = await handle.waitForExit();
      await handle.release();
      // Non-zero exit is surfaced to the model as an error result (with the output
      // so it can react), matching how a normal shell failure would read.
      return exitCode === 0 ? ok(out) : { content: [{ type: "text", text: `${out}\n[exit ${exitCode}]` }], isError: true };
    },

    /** glob: match FILE PATHS under the workspace. Capped + sorted. */
    async glob(args: { pattern: string; path?: string }): Promise<ToolResult> {
      const pattern = (args?.pattern ?? "").trim();
      if (!pattern) return err("glob: no pattern provided");
      const root = sandboxCwd(args?.path);
      // Prune the usual dependency dirs: they dominate both the result and the runtime,
      // and a model asking for "*.ts" never means node_modules.
      const script =
        `find ${shq(root)} \\( -name node_modules -o -name .git -o -name dist -o -name target \\) ` +
        `-prune -o -type f -print 2>/dev/null | grep -E ${shq(globToRegex(pattern))} | ` +
        `sort | head -n ${GLOB_MAX}`;
      const out = await runCapture(exec, script);
      return ok(out.trim() ? out : `no files match ${pattern} under ${root}`);
    },

    /** grep: search file CONTENTS under the workspace. Line-capped. */
    async grep(args: { pattern: string; path?: string; glob?: string }): Promise<ToolResult> {
      const pattern = (args?.pattern ?? "").trim();
      if (!pattern) return err("grep: no pattern provided");
      const root = sandboxCwd(args?.path);
      const include = args?.glob ? ` --include=${shq(args.glob)}` : "";
      // rg when the image has it (faster, skips binaries); grep -rnI otherwise.
      const script =
        `if command -v rg >/dev/null 2>&1; then ` +
        `rg --line-number --no-heading ${shq(pattern)} ${shq(root)} 2>/dev/null; ` +
        `else grep -rnI${include} -e ${shq(pattern)} ${shq(root)} 2>/dev/null; fi | head -n ${GREP_MAX}`;
      const out = await runCapture(exec, script);
      return ok(out.trim() ? out : `no matches for ${pattern} under ${root}`);
    },
    /** read: return the sandbox file's contents. */
    async read(args: { path: string }): Promise<ToolResult> {
      const path = args?.path;
      if (!path) return err("read: no path provided");
      try {
        return ok(await exec.readTextFile(path));
      } catch (e) {
        return err(`read failed for ${path}: ${(e as Error)?.message ?? e}`);
      }
    },

    /** write: create/overwrite a sandbox file. */
    async write(args: { path: string; content: string }): Promise<ToolResult> {
      const path = args?.path;
      if (!path) return err("write: no path provided");
      try {
        await exec.writeTextFile(path, args.content ?? "");
        return ok(`wrote ${path}`);
      } catch (e) {
        return err(`write failed for ${path}: ${(e as Error)?.message ?? e}`);
      }
    },

    /** edit: read → exact-string-replace → write, in the sandbox. Rejects when
     *  old_string is absent (avoid a silent no-op) or ambiguous (must be unique). */
    async edit(args: { path: string; old_string: string; new_string: string }): Promise<ToolResult> {
      const { path, old_string, new_string } = args ?? {};
      if (!path) return err("edit: no path provided");
      if (old_string == null) return err("edit: old_string is required");
      let cur: string;
      try {
        cur = await exec.readTextFile(path);
      } catch (e) {
        return err(`edit failed reading ${path}: ${(e as Error)?.message ?? e}`);
      }
      const first = cur.indexOf(old_string);
      if (first === -1) return err(`edit: old_string not found in ${path}`);
      if (cur.indexOf(old_string, first + old_string.length) !== -1) {
        return err(`edit: old_string is not unique in ${path} — include more context`);
      }
      const next = cur.slice(0, first) + (new_string ?? "") + cur.slice(first + old_string.length);
      try {
        await exec.writeTextFile(path, next);
        return ok(`edited ${path}`);
      } catch (e) {
        return err(`edit failed writing ${path}: ${(e as Error)?.message ?? e}`);
      }
    },
  };
}

/**
 * Build the SDK in-process MCP server whose tools exec into `exec`'s sandbox.
 * Imports the SDK lazily (dynamic import) so this module loads without the SDK
 * package present — the sandboxToolHandlers above are the tested unit.
 *
 * Returns the server config object the SDK's `query({ options: { mcpServers } })`
 * expects, plus the alias/disable lists the query options need.
 */
export async function createSandboxMcpServer(exec: ExecBackend): Promise<{
  server: unknown;
  toolAliases: Record<string, string>;
  disallowedTools: string[];
}> {
  // The SDK's tool()/createSdkMcpServer are zod-v4-typed; we bind our handlers via
  // a loose `any` at the SDK boundary (the handlers themselves are fully typed +
  // unit-tested). This is the only untyped seam — deliberately thin.
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
    createSdkMcpServer: (o: unknown) => unknown;
    tool: (name: string, description: string, schema: unknown, handler: (a: unknown) => Promise<ToolResult>) => unknown;
  };
  const { z } = await import("zod");
  const h = sandboxToolHandlers(exec);

  const server = sdk.createSdkMcpServer({
    name: SANDBOX_SERVER_NAME,
    tools: [
      sdk.tool("bash", "Run a shell command in the sandbox workspace.", { command: z.string(), cwd: z.string().optional() },
        (a) => h.bash(a as { command: string; cwd?: string })),
      sdk.tool("read", "Read a file from the sandbox.", { path: z.string() },
        (a) => h.read(a as { path: string })),
      sdk.tool("write", "Write (create/overwrite) a file in the sandbox.", { path: z.string(), content: z.string() },
        (a) => h.write(a as { path: string; content: string })),
      sdk.tool("edit", "Replace an exact unique string in a sandbox file.", { path: z.string(), old_string: z.string(), new_string: z.string() },
        (a) => h.edit(a as { path: string; old_string: string; new_string: string })),
      sdk.tool("glob", "Find files by path pattern in the sandbox workspace (e.g. '**/*.ts'). Results are sorted and may be capped.", { pattern: z.string(), path: z.string().optional() },
        (a) => h.glob(a as { pattern: string; path?: string })),
      sdk.tool("grep", "Search file contents in the sandbox workspace. Returns file:line:text; results may be capped.", { pattern: z.string(), path: z.string().optional(), glob: z.string().optional() },
        (a) => h.grep(a as { pattern: string; path?: string; glob?: string })),
    ],
  });

  return { server, toolAliases: TOOL_ALIASES, disallowedTools: DISABLED_BUILTINS };
}
