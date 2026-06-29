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
import { debugError } from "../debug.js";

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
      // A UNIQUE id per spawn. It must NOT derive from the command — the ACP
      // terminal id keys the client's per-terminal handle/output maps, so two
      // concurrent identical commands sharing one id would clobber each other
      // (a later spawn overwrites the earlier handle -> its waitForExit never
      // reaches the right goose call -> the tool call hangs forever).
      const id = `term-${nextTerminalSeq()}`;
      let exit: { exitCode: number } | undefined;
      let buffered = ""; // retain output for subscribers that attach after exec

      const exitPromise = api
        .execute(req)
        .then((res): { exitCode: number } => {
          const chunk = res.stdout + (res.stderr ? res.stderr : "");
          buffered += chunk;
          for (const cb of outputCbs) cb(chunk);
          exit = { exitCode: res.exitCode };
          return exit;
        })
        .catch((err): { exitCode: number } => {
          // A failed exec (e.g. transient WS error) must NOT reject — goose's
          // terminal/wait_for_exit would surface "Internal error" and lose the
          // run. Surface it as terminal output + a non-zero exit instead.
          const detail =
            err instanceof Error
              ? err.message
              : typeof err === "object" && err !== null
                ? JSON.stringify(err)
                : String(err);
                    debugError("[exec] spawn execute failed:", detail);
          const msg = `exec failed: ${detail}`;
          buffered += msg;
          for (const cb of outputCbs) cb(msg);
          exit = { exitCode: 1 };
          return exit;
        });

      return {
        id,
        onOutput(cb) {
          outputCbs.add(cb);
          // Replay output that already arrived before this subscriber attached
          // (spawn starts executing immediately; callers subscribe afterwards).
          if (buffered) cb(buffered);
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

// Monotonic terminal-id counter, unique per process. (One agent-host process
// serves many conversations; a shared counter still yields globally-unique ids.)
let terminalSeq = 0;
function nextTerminalSeq(): number {
  return ++terminalSeq;
}

export type { ExecBackend, ExecRequest, ExecResult, TerminalHandle, SandboxRef };
