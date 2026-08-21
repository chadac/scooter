/**
 * Tunnel ExecBackend — the container's ExecBackend impl that forwards the local Claude agent's tool
 * calls to the CLOUD over Channel B, so tools run in the cloud sandbox (not on the user's machine).
 * The SdkAcpClient (@scooter/claude-sdk-provider) calls this; each call sends an exec/fs frame and
 * awaits the cloud's exec_result. See protocol.ts + todo/docs/BYO_CLAUDE_REMOTE_AGENT.md.
 */

import { randomUUID } from "node:crypto";

import type { WireFrame } from "./protocol.js";

/** Structurally matches @scooter/claude-sdk-provider's ExecBackend (kept local to avoid a build
 *  dep on its internal types; the SDK client only calls these methods). */
export interface ExecRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export interface TerminalHandle {
  onOutput(cb: (chunk: string) => void): void;
  waitForExit(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
  id: string;
}
export interface ExecBackend {
  run(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  spawn(req: ExecRequest): TerminalHandle;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
}

export interface TunnelExecDeps {
  /** Send a Channel-B frame to the cloud. */
  send(frame: WireFrame): void;
  /** Register for exec_result frames; returns unsubscribe. */
  onFrame(cb: (frame: WireFrame) => void): () => void;
}

export function createTunnelExecBackend(deps: TunnelExecDeps): ExecBackend {
  const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

  deps.onFrame((frame) => {
    if (frame.ch !== "exec" || frame.type !== "exec_result" || !frame.id) return;
    const p = pending.get(frame.id);
    if (!p) return;
    pending.delete(frame.id);
    const { result, error } = frame.payload as { result?: unknown; error?: string };
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  });

  const request = <R = unknown>(type: string, payload: unknown): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      deps.send({ ch: "exec", type, id, payload });
    });

  return {
    run(req) {
      return request<ExecResult>("exec_run", {
        command: req.command,
        args: req.args,
        cwd: req.cwd,
        env: req.env,
      });
    },
    // Streaming spawn isn't tunneled in the PoC — the SDK's shell tool uses run(); spawn is a
    // fallback the cloud doesn't yet stream. Provide a minimal one-shot adapter over run().
    spawn(req) {
      const id = randomUUID();
      const outCbs = new Set<(c: string) => void>();
      const done = this.run(req).then((r) => {
        for (const cb of outCbs) cb(r.stdout + (r.stderr ?? ""));
        return { exitCode: r.exitCode };
      });
      return {
        id,
        onOutput: (cb) => outCbs.add(cb),
        waitForExit: () => done,
        kill: async () => {},
      };
    },
    async readTextFile(path) {
      const r = await request<{ content: string }>("fs_read", { path });
      return r.content;
    },
    async writeTextFile(path, content) {
      await request("fs_write", { path, content });
    },
  };
}
