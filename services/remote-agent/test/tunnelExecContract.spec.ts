/**
 * Tier 1 — the tunnel ExecBackend satisfies the CONTRACT the SDK's tools actually use.
 *
 * THE BUG (first real BYOC tool call, day after #304): the model ran a shell command and the
 * turn died `handle.release is not a function`. sandboxMcp's bash tool does
 * spawn -> waitForExit -> release; tunnelExec kept its OWN copy of the TerminalHandle
 * interface WITHOUT release(), and the `exec as never` cast at the wiring site silenced the
 * mismatch. It was unreachable until #304 — the handshake hang killed every run before any
 * tool call — so it surfaced as the very next link in the chain.
 *
 * The real fix is the type sharing (tunnelExec now imports the provider's contract, so drift
 * is a compile error); this test drives the actual failing sequence as a backstop.
 */

import { describe, it, expect } from "vitest";

import { createTunnelExecBackend } from "../src/tunnelExec.js";
import type { WireFrame } from "../src/protocol.js";

function backendWithCloud(result: { exitCode: number; stdout: string; stderr?: string }) {
  let onFrame: ((f: WireFrame) => void) | undefined;
  const backend = createTunnelExecBackend({
    send: (f) => {
      // The cloud answers every exec_run with `result` (as the relay would).
      setTimeout(() => onFrame?.({ ch: "exec", type: "exec_result", id: f.id, payload: { result } }), 0);
    },
    onFrame: (cb) => {
      onFrame = cb;
      return () => (onFrame = undefined);
    },
  });
  return backend;
}

describe("tunnel ExecBackend contract", () => {
  it("THE FAILING SEQUENCE: spawn -> waitForExit -> release (the bash tool's exact calls)", async () => {
    const backend = backendWithCloud({ exitCode: 0, stdout: "hi\n" });
    const handle = backend.spawn({ command: "sh", args: ["-lc", "echo hi"], cwd: "/workspace", env: {} });
    let out = "";
    handle.onOutput((c) => (out += c));
    const { exitCode } = await handle.waitForExit();
    await handle.release(); // was: TypeError: handle.release is not a function
    expect(exitCode).toBe(0);
    expect(out).toContain("hi");
  });

  it("kill() also resolves (the other optional-looking-but-required method)", async () => {
    const backend = backendWithCloud({ exitCode: 0, stdout: "" });
    const handle = backend.spawn({ command: "sh", args: ["-lc", "sleep 1"], cwd: "/workspace", env: {} });
    await expect(handle.kill()).resolves.toBeUndefined();
  });
});
