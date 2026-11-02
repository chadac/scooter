/**
 * ExecBackend: services ACP terminal/* and fs/* by running commands in the
 * session's sandbox pod via the Kubernetes exec API, with no in-pod HTTP server.
 * `run` execs and collects output, `readTextFile`/`writeTextFile` exec `cat`/`tee`,
 * and `spawn` execs with streamed output. `connectSandbox` resolves a SandboxRef to
 * a pod-exec client; the unit tier injects a fake SandboxApiClient directly.
 */

import type {
  ExecBackend,
  ExecRequest,
  ExecResult,
  SandboxRef,
  TerminalHandle,
} from "../types.js";
import { debugError } from "../debug.js";
import { formatError, logger } from "../log.js";

const log = logger("exec");

/** Thin exec client for one sandbox pod; production wraps pods/exec and tests inject a fake. */
export interface SandboxApiClient {
  execute(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  download(path: string): Promise<string>;
  upload(path: string, content: string): Promise<void>;
  /** Write raw bytes (base64-encoded) to `path`, creating parent dirs, streaming the base64 over stdin so it survives the single-argv limit. */
  uploadBinary(path: string, base64: string): Promise<void>;
  /** How the exec stream is reached. "k8s-exec" in production. */
  readonly mode: "k8s-exec" | "direct";
}

/** Resolves a SandboxRef to a pod-exec client; implemented in ./k8sExec.ts and re-exported here as the public seam. */
export { connectSandbox } from "./k8sExec.js";

/** Options for the exec backend. */
export interface SandboxExecOptions {
  /** Default per-command deadline in ms (5 min; 0 disables); a request's `timeoutMs` overrides it. */
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

    writeBinaryFile(path, base64) {
      return api.uploadBinary(path, base64);
    },

    spawn(req): TerminalHandle {
      // A terminal is modelled as a single execution whose output is streamed once, then an exit.
      const outputCbs = new Set<(chunk: string) => void>();
      // A unique id per spawn, never derived from the command, since the ACP terminal id
      // keys the client's per-terminal maps and two concurrent identical commands must not collide.
      const id = `term-${nextTerminalSeq()}`;
      let exit: { exitCode: number } | undefined;
      let buffered = ""; // retain output for subscribers that attach after exec

      // Aborting closes the exec's pods/exec WebSocket, which SIGTERMs the command's shell.
      const controller = new AbortController();

      // `timedOut` distinguishes the hard timeout from a user kill so goose gets an
      // actionable "timed out" result.
      let timedOut = false;
      const timeoutMs = req.timeoutMs ?? commandTimeoutMs;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs)
          : undefined;
      const clearTimer = () => {
        if (timer) clearTimeout(timer);
      };

      // A user kill settles the terminal at once rather than waiting for `execute` to notice
      // the abort: in production `execute` first waits (up to 90s, signal-blind) for a ready
      // sandbox pod, so a Stop pressed during a cold start would otherwise do nothing until the
      // pod came up. The late execute then sees an already-aborted signal and never runs.
      let killed = false;
      let resolveKilled: (r: { exitCode: number }) => void = () => {};
      const killedPromise = new Promise<{ exitCode: number }>((r) => (resolveKilled = r));

      const execPromise = api
        .execute(req, controller.signal)
        .then((res): { exitCode: number } => {
          clearTimer();
          if (killed) return exit!;
          const chunk = res.stdout + (res.stderr ? res.stderr : "");
          buffered += chunk;
          for (const cb of outputCbs) cb(chunk);
          exit = { exitCode: res.exitCode };
          return exit;
        })
        .catch((err): { exitCode: number } => {
          clearTimer();
          if (killed) return exit!;
          // A failed exec must not reject (goose's terminal/wait_for_exit would lose the
          // run), so surface it as terminal output plus a non-zero exit.
          const formatted = formatError(err);
          const detail = String(formatted.message ?? JSON.stringify(formatted));
          log.errorWith("spawn execute failed", err);
          const msg = timedOut
            ? `command timed out after ${Math.round(timeoutMs / 1000)}s and was terminated — ` +
              `narrow it (e.g. scope the path, avoid scanning /nix/store or /) or run it in the background`
            : `exec failed: ${detail}`;
          buffered += msg;
          for (const cb of outputCbs) cb(msg);
          exit = { exitCode: timedOut ? 124 : 1 }; // 124 = the conventional timeout exit code
          return exit;
        });
      const exitPromise = Promise.race([execPromise, killedPromise]);

      return {
        id,
        onOutput(cb) {
          outputCbs.add(cb);
          // Replay output that arrived before this subscriber attached.
          if (buffered) cb(buffered);
        },
        async waitForExit() {
          return exit ?? (await exitPromise);
        },
        async kill() {
          // Close this exec's WebSocket, which SIGTERMs the command's shell; idempotent.
          clearTimer();
          controller.abort();
          if (exit || killed) return;
          killed = true;
          // 130 = killed by SIGINT/SIGTERM-style interrupt, the same code the exec layer uses.
          exit = { exitCode: 130 };
          resolveKilled(exit);
        },
        async release() {
          clearTimer();
          outputCbs.clear();
        },
      };
    },
  };
}

// Monotonic terminal-id counter, unique per process.
let terminalSeq = 0;
function nextTerminalSeq(): number {
  return ++terminalSeq;
}

export type { ExecBackend, ExecRequest, ExecResult, TerminalHandle, SandboxRef };
