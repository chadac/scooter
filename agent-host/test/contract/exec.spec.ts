/**
 * Tier 1 contract test — ExecBackend over the agent-sandbox API.
 *
 * Asserts ACP client methods (terminal/*, fs/*) map onto /execute, /upload,
 * /download against a fake sandbox API. RED against Design interfaces.
 */

import { describe, it, expect } from "vitest";

import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
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
});
