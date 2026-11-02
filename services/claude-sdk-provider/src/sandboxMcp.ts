/**
 * In-process MCP server exposing sandbox-routed bash/read/write/edit/glob/grep tools
 * to the Claude Agent SDK. Claude's own built-ins are disabled and aliased to these
 * tools, whose handlers exec through the per-conversation ExecBackend into the
 * sandbox pod. The pure handlers (sandboxToolHandlers) are testable with a fake
 * ExecBackend; createSandboxMcpServer imports the SDK lazily so the module loads
 * without it.
 */

import type { ExecBackend } from "./types.js";
import { SUBAGENT_BUILTINS } from "./toolPolicy.js";

/** The MCP CallToolResult shape, redeclared locally so the handlers do not depend on the SDK at type time. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

/** The SDK exposes the server's tools to the model as `mcp__sandbox__<name>`; the alias map redirects the built-ins onto them. */
export const SANDBOX_SERVER_NAME = "sandbox";
export const TOOL_ALIASES: Record<string, string> = {
  Bash: "mcp__sandbox__bash",
  Read: "mcp__sandbox__read",
  Edit: "mcp__sandbox__edit",
  Write: "mcp__sandbox__write",
  Glob: "mcp__sandbox__glob",
  Grep: "mcp__sandbox__grep",
};
/** The built-ins hidden from the model: the local shell/file tools (aliased into the sandbox) and the native subagent tools, whose subagents never reach the UI, so the model sees only `spawn_subagent`. */
export const DISABLED_BUILTINS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", ...SUBAGENT_BUILTINS];

/** Commands run under /workspace unless an absolute /workspace path is given. */
const DEFAULT_CWD = "/workspace";
function sandboxCwd(cwd?: string): string {
  return cwd && cwd.startsWith("/workspace") ? cwd : DEFAULT_CWD;
}

/** Output caps so a repo-wide search cannot bury the model's context. */
const GLOB_MAX = 300;
const GREP_MAX = 200;

/** Longest per-call bash timeout the model may request, in seconds. */
export const BASH_TIMEOUT_MAX_S = 30 * 60;

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
/** Image types the model accepts, keyed by lower-case extension. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
/** The API rejects images over 5 MB. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Exit code the image script uses to report an oversized file. */
const TOO_BIG_EXIT = 3;

/** The image mime type for `path`, or undefined when it is not a viewable image. */
export function imageMimeType(path: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? IMAGE_MIME[m[1].toLowerCase()] : undefined;
}

/** Read a sandbox image as base64, size-checked in the pod so an oversized file is never shipped. */
async function readImage(exec: ExecBackend, path: string, mimeType: string): Promise<ToolResult> {
  const p = shq(path);
  const script =
    `sz=$(stat -c %s -- ${p}) || exit 1; ` +
    `if [ "$sz" -gt ${IMAGE_MAX_BYTES} ]; then echo "$sz" >&2; exit ${TOO_BIG_EXIT}; fi; ` +
    `base64 -w0 -- ${p}`;
  const res = await exec.run({ command: "sh", args: ["-c", script], cwd: DEFAULT_CWD, env: {} });
  if (res.exitCode === TOO_BIG_EXIT) {
    return err(`read: ${path} is ${res.stderr.trim()} bytes; images over ${IMAGE_MAX_BYTES} bytes cannot be viewed — downscale it first`);
  }
  if (res.exitCode !== 0) return err(`read failed for ${path}: ${(res.stderr || res.stdout).trim() || `exit ${res.exitCode}`}`);
  const data = res.stdout.replace(/\s+/g, "");
  if (!data) return err(`read: ${path} is empty`);
  return { content: [{ type: "image", data, mimeType }] };
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** The pure tool handlers, bound to a conversation's ExecBackend. */
export function sandboxToolHandlers(exec: ExecBackend) {
  return {
    /** Run a shell command in the sandbox and return the combined output. */
    async bash(args: { command: string; cwd?: string; timeout?: number }): Promise<ToolResult> {
      const command = (args?.command ?? "").trim();
      if (!command) return err("bash: no command provided");
      const timeout = args?.timeout;
      if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0 && timeout <= BASH_TIMEOUT_MAX_S)) {
        return err(`bash: timeout must be over 0 and at most ${BASH_TIMEOUT_MAX_S} seconds`);
      }
      const handle = exec.spawn({
        command: "sh",
        args: ["-lc", command],
        cwd: sandboxCwd(args?.cwd),
        env: {},
        ...(timeout !== undefined ? { timeoutMs: Math.round(timeout * 1000) } : {}),
      });
      let out = "";
      handle.onOutput((chunk) => {
        out += chunk;
      });
      const { exitCode } = await handle.waitForExit();
      await handle.release();
      // A non-zero exit is surfaced to the model as an error result carrying the output.
      return exitCode === 0 ? ok(out) : { content: [{ type: "text", text: `${out}\n[exit ${exitCode}]` }], isError: true };
    },

    /** Match file paths under the workspace, sorted and capped. */
    async glob(args: { pattern: string; path?: string }): Promise<ToolResult> {
      const pattern = (args?.pattern ?? "").trim();
      if (!pattern) return err("glob: no pattern provided");
      const root = sandboxCwd(args?.path);
      // Prune the usual dependency dirs, which dominate both the result and the runtime.
      const script =
        `find ${shq(root)} \\( -name node_modules -o -name .git -o -name dist -o -name target \\) ` +
        `-prune -o -type f -print 2>/dev/null | grep -E ${shq(globToRegex(pattern))} | ` +
        `sort | head -n ${GLOB_MAX}`;
      const out = await runCapture(exec, script);
      return ok(out.trim() ? out : `no files match ${pattern} under ${root}`);
    },

    /** Search file contents under the workspace, line-capped. */
    async grep(args: { pattern: string; path?: string; glob?: string }): Promise<ToolResult> {
      const pattern = (args?.pattern ?? "").trim();
      if (!pattern) return err("grep: no pattern provided");
      const root = sandboxCwd(args?.path);
      const include = args?.glob ? ` --include=${shq(args.glob)}` : "";
      // rg when the image has it, grep -rnI otherwise.
      const script =
        `if command -v rg >/dev/null 2>&1; then ` +
        `rg --line-number --no-heading ${shq(pattern)} ${shq(root)} 2>/dev/null; ` +
        `else grep -rnI${include} -e ${shq(pattern)} ${shq(root)} 2>/dev/null; fi | head -n ${GREP_MAX}`;
      const out = await runCapture(exec, script);
      return ok(out.trim() ? out : `no matches for ${pattern} under ${root}`);
    },
    /** Return a sandbox file's contents, or the image itself for a png/jpeg/gif/webp. */
    async read(args: { path: string }): Promise<ToolResult> {
      const path = args?.path;
      if (!path) return err("read: no path provided");
      const mimeType = imageMimeType(path);
      if (mimeType) {
        try {
          return await readImage(exec, path, mimeType);
        } catch (e) {
          return err(`read failed for ${path}: ${(e as Error)?.message ?? e}`);
        }
      }
      try {
        return ok(await exec.readTextFile(path));
      } catch (e) {
        return err(`read failed for ${path}: ${(e as Error)?.message ?? e}`);
      }
    },

    /** Create or overwrite a sandbox file. */
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

    /** Exact-string replace in a sandbox file, rejecting an absent or non-unique old_string. */
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

/** Build the SDK in-process MCP server whose tools exec into `exec`'s sandbox, plus the alias/disable lists the query options need. */
export async function createSandboxMcpServer(exec: ExecBackend): Promise<{
  server: unknown;
  toolAliases: Record<string, string>;
  disallowedTools: string[];
}> {
  // The SDK's tool()/createSdkMcpServer are zod-v4-typed, so the handlers are bound through a loose cast at this one seam.
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
    createSdkMcpServer: (o: unknown) => unknown;
    tool: (name: string, description: string, schema: unknown, handler: (a: unknown) => Promise<ToolResult>) => unknown;
  };
  const { z } = await import("zod");
  const h = sandboxToolHandlers(exec);

  const server = sdk.createSdkMcpServer({
    name: SANDBOX_SERVER_NAME,
    tools: [
      sdk.tool(
        "bash",
        "Run a shell command in the sandbox workspace. It blocks until the command exits or times out " +
          `(the deployment default, normally 5 min). Set \`timeout\` (seconds, max ${BASH_TIMEOUT_MAX_S}) shorter for commands that might hang, ` +
          "or longer for a known-slow build; use run_background for anything longer.",
        {
          command: z.string(),
          cwd: z.string().optional(),
          timeout: z.number().positive().max(BASH_TIMEOUT_MAX_S).optional().describe("Seconds before the command is killed."),
        },
        (a) => h.bash(a as { command: string; cwd?: string; timeout?: number }),
      ),
      sdk.tool("read", "Read a file from the sandbox. Images (.png, .jpg, .jpeg, .gif, .webp, up to 5 MB) are returned as images you can see, e.g. screenshots.", { path: z.string() },
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
