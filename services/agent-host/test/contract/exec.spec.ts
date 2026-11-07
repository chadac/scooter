/** ExecBackend over the agent-sandbox API: terminal/* and fs/* map onto /execute, /upload and /download. */

import { describe, it, expect, vi } from "vitest";

import { createSandboxExecBackend, type SandboxApiClient } from "../../src/exec/sandboxExec.js";
import type { ExecResult } from "../../src/types.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";

describe("ExecBackend (agent-sandbox SDK)", () => {
  it("run() forwards to /execute and returns the result", async () => {
    const api = createFakeSandboxApi();
    api.whenExecute((command) => ({ stdout: `ran ${command}`, stderr: "", exitCode: 0 }));
    const exec = createSandboxExecBackend(api);

    const res = await exec.run({ command: "echo", args: ["hi"] });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("echo");
    expect(api.executed).toContainEqual({ command: "echo", args: ["hi"] });
  });

  it("readTextFile() maps to /download", async () => {
    const api = createFakeSandboxApi();
    api.setFile("/workspace/a.txt", "contents");
    const exec = createSandboxExecBackend(api);

    expect(await exec.readTextFile("/workspace/a.txt")).toBe("contents");
  });

  it("writeTextFile() maps to /upload", async () => {
    const api = createFakeSandboxApi();
    const exec = createSandboxExecBackend(api);

    await exec.writeTextFile("/workspace/b.txt", "data");

    expect(api.getFile("/workspace/b.txt")).toBe("data");
  });

  it("writeBinaryFile() streams base64 (not a shell arg) and round-trips binary bytes", async () => {
    const api = createFakeSandboxApi();
    const exec = createSandboxExecBackend(api);
    // NUL and high bytes that a UTF-8 string round-trip would corrupt.
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x89, 0x50, 0x4e, 0x47]);
    const b64 = bytes.toString("base64");

    await exec.writeBinaryFile("/workspace/uploads/x.bin", b64);

    expect(api.uploadedBinary).toEqual([{ path: "/workspace/uploads/x.bin", base64: b64 }]);
    // A single argv string is capped at MAX_ARG_STRLEN, so the base64 must not ride as a shell argument.
    const shell = api.executed.map((e) => [e.command, ...e.args].join(" ")).join("\n");
    expect(shell).not.toContain(b64);
  });

  it("spawn() streams incremental terminal output and an exit code", async () => {
    const api = createFakeSandboxApi();
    api.whenExecute(() => ({ stdout: "line1\nline2\n", stderr: "", exitCode: 0 }));
    const exec = createSandboxExecBackend(api);

    const term = exec.spawn({ command: "seq", args: ["2"] });
    const chunks: string[] = [];
    term.onOutput((c) => chunks.push(c));
    const { exitCode } = await term.waitForExit();

    expect(exitCode).toBe(0);
    expect(chunks.join("")).toContain("line1");
    await term.release();
  });

  it("concurrent spawns of the SAME command get DISTINCT terminal ids", () => {
    // Identical concurrent calls colliding on one id would clobber the ACP client's per-id terminal maps.
    const api = createFakeSandboxApi();
    const exec = createSandboxExecBackend(api);

    const a = exec.spawn({ command: "bash", args: ["-c", "echo hi"] });
    const b = exec.spawn({ command: "bash", args: ["-c", "echo hi"] });
    const c = exec.spawn({ command: "bash", args: ["-c", "echo hi"] });

    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("concurrent identical spawns each resolve independently (no orphaned hang)", async () => {
    // Distinct per-call exit codes prove no handle was overwritten.
    const api = createFakeSandboxApi();
    let n = 0;
    api.whenExecute(() => ({ stdout: `out${n}`, stderr: "", exitCode: n++ }));
    const exec = createSandboxExecBackend(api);

    const terms = [0, 1, 2].map(() => exec.spawn({ command: "bash", args: ["-c", "x"] }));
    const exits = await Promise.all(terms.map((t) => t.waitForExit()));

    expect(exits.map((e) => e.exitCode).sort()).toEqual([0, 1, 2]);
  });
});

describe("ExecBackend kill before the exec starts (Stop during a sandbox cold start)", () => {
  // Production's execute() first waits for a ready sandbox pod, and that wait ignores the
  // AbortSignal; model it as an execute that only settles when the test releases it.
  function podWaitApi() {
    let release: () => void = () => {};
    const podReady = new Promise<void>((r) => (release = r));
    let ran = false;
    const api: SandboxApiClient = {
      mode: "k8s-exec",
      async execute(_req, signal): Promise<ExecResult> {
        await podReady;
        if (signal?.aborted) return { stdout: "", stderr: "aborted", exitCode: 130 };
        ran = true;
        return { stdout: "slept", stderr: "", exitCode: 0 };
      },
      async download() { return ""; },
      async upload() {},
      async uploadBinary() {},
    };
    return { api, release, ran: () => ran };
  }

  it("kill() settles the terminal without waiting for the pod", async () => {
    const pod = podWaitApi();
    const exec = createSandboxExecBackend(pod.api, { commandTimeoutMs: 0 });
    const term = exec.spawn({ command: "sleep", args: ["20"] });
    const exitP = term.waitForExit();
    await term.kill();
    // The pod is still not ready, yet the exit has already landed.
    await expect(exitP).resolves.toEqual({ exitCode: 130 });
    // When the pod does come up, the command never runs and the exit does not change.
    pod.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(pod.ran()).toBe(false);
    await expect(term.waitForExit()).resolves.toEqual({ exitCode: 130 });
  });

  it("kill() after the command finished keeps the real exit code", async () => {
    const pod = podWaitApi();
    const exec = createSandboxExecBackend(pod.api, { commandTimeoutMs: 0 });
    const term = exec.spawn({ command: "true", args: [] });
    pod.release();
    await expect(term.waitForExit()).resolves.toEqual({ exitCode: 0 });
    await term.kill();
    await expect(term.waitForExit()).resolves.toEqual({ exitCode: 0 });
  });
});

describe("ExecBackend hard command timeout (P0 — runaway-command deadlock fix)", () => {
  /** An api whose execute() hangs until its AbortSignal fires, then rejects as the real pods/exec WS does on close. */
  function hangingApi(): SandboxApiClient {
    return {
      mode: "k8s-exec",
      async execute(_req, signal): Promise<ExecResult> {
        return new Promise<ExecResult>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted (WS closed)")));
        });
      },
      async download() { return ""; },
      async upload() {},
    };
  }

  it("aborts a command that outruns the deadline and returns exit 124 + a timeout message", async () => {
    vi.useFakeTimers();
    try {
      const exec = createSandboxExecBackend(hangingApi(), { commandTimeoutMs: 5000 });
      const term = exec.spawn({ command: "grep", args: ["-r", "x", "/"] });
      const chunks: string[] = [];
      term.onOutput((c) => chunks.push(c));
      const exitP = term.waitForExit();

      await vi.advanceTimersByTimeAsync(5000);
      const { exitCode } = await exitP;

      expect(exitCode).toBe(124);
      expect(chunks.join("")).toMatch(/timed out after 5s/i);
      expect(chunks.join("")).toMatch(/narrow it|background/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the command never started when the pod wasn't Ready, instead of 'narrow it'", async () => {
    vi.useFakeTimers();
    try {
      const api = { ...hangingApi(), waitingFor: () => "the sandbox pod has not been Ready for 5s" };
      const exec = createSandboxExecBackend(api, { commandTimeoutMs: 5000 });
      const term = exec.spawn({ command: "echo", args: ["ok"] });
      const chunks: string[] = [];
      term.onOutput((c) => chunks.push(c));
      const exitP = term.waitForExit();
      await vi.advanceTimersByTimeAsync(5000);
      const { exitCode } = await exitP;
      const out = chunks.join("");
      expect(exitCode).toBe(124);
      expect(out).toMatch(/never started: the sandbox pod has not been Ready/);
      expect(out).not.toMatch(/narrow it/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT time out a command that finishes in time", async () => {
    vi.useFakeTimers();
    try {
      const api: SandboxApiClient = {
        mode: "k8s-exec",
        async execute() { return { stdout: "done", stderr: "", exitCode: 0 }; },
        async download() { return ""; },
        async upload() {},
      };
      const exec = createSandboxExecBackend(api, { commandTimeoutMs: 5000 });
      const term = exec.spawn({ command: "echo", args: ["hi"] });
      const { exitCode } = await term.waitForExit();
      // Advancing past the deadline must not change the settled result.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(exitCode).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a request's timeoutMs overrides the backend default, shorter or longer", async () => {
    vi.useFakeTimers();
    try {
      const exec = createSandboxExecBackend(hangingApi(), { commandTimeoutMs: 5000 });
      const short = exec.spawn({ command: "sleep", args: ["9"], timeoutMs: 1000 });
      const shortOut: string[] = [];
      short.onOutput((c) => shortOut.push(c));
      const long = exec.spawn({ command: "make", args: [], timeoutMs: 20_000 });
      let longSettled = false;
      const longP = long.waitForExit().then((r) => ((longSettled = true), r));

      await vi.advanceTimersByTimeAsync(1000);
      expect((await short.waitForExit()).exitCode).toBe(124);
      expect(shortOut.join("")).toMatch(/timed out after 1s/i);

      // Still running past the 5s default.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(longSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await longP).exitCode).toBe(124);
    } finally {
      vi.useRealTimers();
    }
  });

  it("commandTimeoutMs=0 disables the timeout (a long command is not aborted by a timer)", async () => {
    vi.useFakeTimers();
    try {
      const exec = createSandboxExecBackend(hangingApi(), { commandTimeoutMs: 0 });
      const term = exec.spawn({ command: "sleep", args: ["999"] });
      let settled = false;
      void term.waitForExit().then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(settled).toBe(false);
      await term.kill();
    } finally {
      vi.useRealTimers();
    }
  });
});
