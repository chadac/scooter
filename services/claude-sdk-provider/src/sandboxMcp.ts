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
};
/** The built-in tools we disable so the model can't run them locally. */
export const DISABLED_BUILTINS = ["Bash", "Read", "Edit", "Write"];

/** The agent's work happens in the sandbox workspace. goose's ACP createTerminal
 *  uses the same default: run under /workspace unless an absolute /workspace path
 *  is given (a cwd in the agent-host pod doesn't exist in the sandbox). */
const DEFAULT_CWD = "/workspace";
function sandboxCwd(cwd?: string): string {
  return cwd && cwd.startsWith("/workspace") ? cwd : DEFAULT_CWD;
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
    ],
  });

  return { server, toolAliases: TOOL_ALIASES, disallowedTools: DISABLED_BUILTINS };
}
