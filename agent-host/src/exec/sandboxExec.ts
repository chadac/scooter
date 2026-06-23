/**
 * SDK-backed ExecBackend — services ACP terminal/* and fs/* by calling the
 * agent-sandbox API against the session's pod.
 *
 * Maps:
 *   ExecBackend.run          -> agent-sandbox POST /execute
 *   ExecBackend.readTextFile -> GET /download/{path}
 *   ExecBackend.writeTextFile-> POST /upload
 *   ExecBackend.spawn        -> streamed /execute (incremental output)
 *
 * `connectSandbox` (resolving a SandboxRef to a real SandboxApiClient over the
 * router) is implemented at the cluster-integration stage; the unit tier injects
 * a fake SandboxApiClient directly.
 */

import type {
  ExecBackend,
  ExecRequest,
  ExecResult,
  SandboxRef,
  TerminalHandle,
} from "../types.js";

/** Thin client over the agent-sandbox router for one sandbox. */
export interface SandboxApiClient {
  execute(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  download(path: string): Promise<string>;
  upload(path: string, content: string): Promise<void>;
  readonly mode: "gateway" | "port-forward" | "in-cluster" | "direct";
}

/** Resolves a SandboxRef to a connected SandboxApiClient (via the router). */
export declare function connectSandbox(ref: SandboxRef): Promise<SandboxApiClient>;

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
