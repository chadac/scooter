/**
 * Local exec backend — runs commands in the agent-host process (no cluster).
 *
 * Used in FAKE mode only, so the dummy agent's real tool calls (ACP
 * createTerminal -> bridge -> ExecBackend) exercise the full chain end to end
 * without a sandbox pod. Implements the SandboxApiClient seam the same way the
 * K8s exec backend does; commands run as local subprocesses.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

import type { ExecRequest, ExecResult } from "../types.js";
import type { SandboxApiClient } from "./sandboxExec.js";

export function createLocalSandboxApiClient(): SandboxApiClient {
  const files = new Map<string, string>();

  const run = (req: ExecRequest, signal?: AbortSignal): Promise<ExecResult> =>
    new Promise((resolve) => {
      // The ACP client maps the agent's cwd to the sandbox's /workspace, which
      // does NOT exist on the local agent-host filesystem in fake mode — spawn
      // would fail with ENOENT on the cwd. Fall back to a real, writable dir so
      // the fake exec chain still runs the command.
      const cwd = req.cwd && existsSync(req.cwd) ? req.cwd : tmpdir();
      if (signal?.aborted) {
        resolve({ stdout: "", stderr: "aborted", exitCode: 130 });
        return;
      }
      const child = spawn(req.command, req.args, {
        cwd,
        env: { ...process.env, ...req.env },
        shell: false,
      });
      // Cancel kills the child (SIGTERM, then SIGKILL if it lingers) — the
      // fake-mode equivalent of closing the k8s exec WebSocket.
      const onAbort = () => {
        child.kill("SIGTERM");
        setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 500);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode: signal?.aborted ? 130 : (code ?? 0) });
      });
      child.on("error", (e) => resolve({ stdout, stderr: String(e), exitCode: 127 }));
    });

  return {
    mode: "direct",
    execute: (req, signal) => run(req, signal),
    async download(path) {
      const c = files.get(path);
      if (c === undefined) throw new Error(`no such file: ${path}`);
      return c;
    },
    async upload(path, content) {
      files.set(path, content);
    },
  };
}
