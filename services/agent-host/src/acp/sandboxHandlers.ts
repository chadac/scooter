/**
 * The ACP client-method handlers that service Goose's fs/* and terminal/*
 * callbacks against the ExecBackend. Extracted from client.ts so they can be
 * unit-tested WITHOUT spawning a real `goose acp` subprocess.
 *
 * Terminal bookkeeping lives here: a per-terminal handle map + an output buffer
 * map, both keyed by the ExecBackend handle's id. That id is UNIQUE per spawn
 * (see sandboxExec.ts), so concurrent terminals never collide on a key — the bug
 * this seam exists to test: identical concurrent bash calls used to share one id
 * and clobber each other's handle/buffer, hanging the orphaned call.
 */

import type * as schema from "@zed-industries/agent-client-protocol";

import type { ExecBackend } from "../types.js";
import { debug } from "../debug.js";

/** The subset of ACP Client methods that map onto the ExecBackend. */
export interface SandboxClientHandlers {
  readTextFile(p: schema.ReadTextFileRequest): Promise<schema.ReadTextFileResponse>;
  writeTextFile(p: schema.WriteTextFileRequest): Promise<schema.WriteTextFileResponse>;
  createTerminal(p: schema.CreateTerminalRequest): Promise<schema.CreateTerminalResponse>;
  terminalOutput(p: schema.TerminalOutputRequest): Promise<schema.TerminalOutputResponse>;
  waitForTerminalExit(
    p: schema.WaitForTerminalExitRequest,
  ): Promise<schema.WaitForTerminalExitResponse>;
  releaseTerminal(
    p: schema.ReleaseTerminalRequest,
  ): Promise<schema.ReleaseTerminalResponse | void>;
  killTerminal(p: schema.KillTerminalCommandRequest): Promise<schema.KillTerminalResponse | void>;
}

export function createSandboxClientHandlers(exec: ExecBackend): SandboxClientHandlers {
  // Per-terminal handle + accumulated output, keyed by the (unique) handle id.
  const terminals = new Map<string, ReturnType<ExecBackend["spawn"]>>();
  const terminalBuffers = new Map<string, string>();

  return {
    async readTextFile(params) {
      const content = await exec.readTextFile(params.path);
      return { content };
    },

    async writeTextFile(params) {
      await exec.writeTextFile(params.path, params.content);
      return {};
    },

    async createTerminal(params) {
      debug("[acp] createTerminal:", JSON.stringify({ command: params.command, args: params.args, cwd: params.cwd }));
      // goose passes ITS OWN session cwd (a path in the agent-host pod), which
      // does not exist in the sandbox. The agent's work happens in the sandbox
      // workspace, so run there unless goose gave a sandbox-absolute path under
      // /workspace. (A `cd` to a missing dir would fail the whole command.)
      const sandboxCwd =
        params.cwd && params.cwd.startsWith("/workspace") ? params.cwd : "/workspace";
      const handle = exec.spawn({
        command: params.command,
        args: params.args ?? [],
        cwd: sandboxCwd,
        env: Object.fromEntries((params.env ?? []).map((e) => [e.name, e.value])),
      });
      terminals.set(handle.id, handle);
      // Accumulate streamed output so terminalOutput() can read it.
      terminalBuffers.set(handle.id, "");
      handle.onOutput((chunk) => {
        terminalBuffers.set(handle.id, (terminalBuffers.get(handle.id) ?? "") + chunk);
      });
      return { terminalId: handle.id };
    },

    async terminalOutput(params) {
      const buf = terminalBuffers.get(params.terminalId) ?? "";
      debug("[acp] terminalOutput:", params.terminalId, JSON.stringify(buf.slice(0, 200)));
      return { output: buf, truncated: false };
    },

    async waitForTerminalExit(params) {
      const handle = terminals.get(params.terminalId);
      if (!handle) return { exitCode: 1 };
      const { exitCode } = await handle.waitForExit();
      return { exitCode };
    },

    async releaseTerminal(params) {
      await terminals.get(params.terminalId)?.release();
      terminals.delete(params.terminalId);
      terminalBuffers.delete(params.terminalId);
    },

    async killTerminal(params) {
      await terminals.get(params.terminalId)?.kill();
    },
  };
}
