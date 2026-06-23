/**
 * ExecBackend — services ACP terminal/* and fs/* by running commands in the
 * session's sandbox pod via the **Kubernetes exec API** (pods/exec subresource),
 * the same mechanism upstream examples/sandboxed-tools uses. There is no in-pod
 * HTTP server.
 *
 * Maps (all over `kubectl exec`-equivalent):
 *   ExecBackend.run          -> exec the command, collect stdout/stderr/exit
 *   ExecBackend.readTextFile -> exec `cat <path>` (or tar stream)
 *   ExecBackend.writeTextFile-> exec a writer (tar-in / `tee <path>`)
 *   ExecBackend.spawn        -> exec with streamed stdout
 *
 * `connectSandbox` resolves a SandboxRef to a pod-exec client (needs pods/exec
 * RBAC on the agent-host SA); implemented at the cluster-integration stage. The
 * unit tier injects a fake SandboxApiClient directly.
 */

import type {
  ExecBackend,
  ExecRequest,
  ExecResult,
  SandboxRef,
  TerminalHandle,
} from "../types.js";

/**
 * Thin exec client for one sandbox pod. Production impl wraps the Kubernetes
 * pods/exec API; tests inject a fake.
 */
export interface SandboxApiClient {
  execute(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  download(path: string): Promise<string>;
  upload(path: string, content: string): Promise<void>;
  /** How the exec stream is reached. "k8s-exec" in production. */
  readonly mode: "k8s-exec" | "direct";
}

/**
 * Resolves a SandboxRef to a pod-exec client (Kubernetes exec API).
 * Implemented in ./k8sExec.ts; re-exported here as the public seam.
 */
export { connectSandbox } from "./k8sExec.js";

/** Constructs an ExecBackend bound to one sandbox. */
export function createSandboxExecBackend(api: SandboxApiClient): ExecBackend {
  return {
    run(req, signal) {
      return api.execute(req, signal);
    },

    readTextFile(path) {
      return api.download(path);
    },

    writeTextFile(path, content) {
      return api.upload(path, content);
    },

    spawn(req): TerminalHandle {
      // The agent-sandbox contract is request/response (/execute), not a live
      // PTY. We model a terminal as a single execution whose output is streamed
      // once, then an exit. (A future runtime-side streaming endpoint can make
      // onOutput truly incremental.)
      const outputCbs = new Set<(chunk: string) => void>();
      const id = `term-${Math.abs(hashRef(req))}`;
      let exit: { exitCode: number } | undefined;

      const exitPromise = api.execute(req).then((res): { exitCode: number } => {
        const chunk = res.stdout + (res.stderr ? res.stderr : "");
        for (const cb of outputCbs) cb(chunk);
        exit = { exitCode: res.exitCode };
        return exit;
      });

      return {
        id,
        onOutput(cb) {
          outputCbs.add(cb);
        },
        async waitForExit() {
          return exit ?? (await exitPromise);
        },
        async kill() {
          /* no-op: single-shot exec cannot be signalled mid-flight */
        },
        async release() {
          outputCbs.clear();
        },
      };
    },
  };
}

function hashRef(req: ExecRequest): number {
  const s = `${req.command} ${req.args.join(" ")}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export type { ExecBackend, ExecRequest, ExecResult, TerminalHandle, SandboxRef };
