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

/** Options for the exec backend. */
export interface SandboxExecOptions {
  /** Hard per-command deadline (ms). A running command that exceeds it is aborted
   *  (WS close → SIGTERM) and returns a timeout message + non-zero exit, so a
   *  runaway command (e.g. `grep -r / …`) can't deadlock the conversation. Default
   *  5 min; 0 disables the timeout. Goose's developer `timeout` is only advisory —
   *  THIS is the enforced one. */
  commandTimeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Constructs an ExecBackend bound to one sandbox. */
export function createSandboxExecBackend(api: SandboxApiClient, opts: SandboxExecOptions = {}): ExecBackend {
  const commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
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

      // Cancellation: an AbortController closes the exec's pods/exec WebSocket,
      // which SIGTERMs the command's shell (a foreground command dies with it).
      // This covers the common "stop a running command" case. A thorough
      // process-group reap of orphaned background children (setsid/pkill) is a
      // follow-up (needs util-linux/procps in the sandbox image + a cluster test).
      const controller = new AbortController();

      // P0 hard timeout: a command that outruns the deadline is aborted so a
      // runaway (`grep -r / …`, an infinite loop) can't hang goose's
      // terminal/wait_for_exit and deadlock the whole conversation. `timedOut`
      // distinguishes it from a user kill()/abort so goose gets an actionable
      // "timed out" result (not a bare "exec failed").
      let timedOut = false;
      const timer =
        commandTimeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, commandTimeoutMs)
          : undefined;
      const clearTimer = () => {
        if (timer) clearTimeout(timer);
      };

      const exitPromise = api
        .execute(req, controller.signal)
        .then((res): { exitCode: number } => {
          clearTimer();
          const chunk = res.stdout + (res.stderr ? res.stderr : "");
          buffered += chunk;
          for (const cb of outputCbs) cb(chunk);
          exit = { exitCode: res.exitCode };
          return exit;
        })
        .catch((err): { exitCode: number } => {
          clearTimer();
          // A failed exec (e.g. transient WS error) must NOT reject — goose's
          // terminal/wait_for_exit would surface "Internal error" and lose the
          // run. Surface it as terminal output + a non-zero exit instead. A
          // TIMEOUT gets a specific message so the agent knows to narrow the
          // command (not retry it verbatim).
          const detail =
            err instanceof Error
              ? err.message
              : typeof err === "object" && err !== null
                ? JSON.stringify(err)
                : String(err);
                    debugError("[exec] spawn execute failed:", detail);
          const msg = timedOut
            ? `command timed out after ${Math.round(commandTimeoutMs / 1000)}s and was terminated — ` +
              `narrow it (e.g. scope the path, avoid scanning /nix/store or /) or run it in the background`
            : `exec failed: ${detail}`;
          buffered += msg;
          for (const cb of outputCbs) cb(msg);
          exit = { exitCode: timedOut ? 124 : 1 }; // 124 = the conventional timeout exit code
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
          // Close this exec's WebSocket → SIGTERM to the command's shell. Idempotent.
          clearTimer();
          controller.abort();
        },
        async release() {
          clearTimer();
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
