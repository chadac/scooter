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

  it("concurrent spawns of the SAME command get DISTINCT terminal ids", () => {
    // Regression: ids were hash(command+args), so identical concurrent bash
    // calls collided on one id — the ACP client's per-id terminal/buffer maps
    // then clobbered each other and a call's waitForExit never resolved (hang).
    const api = createFakeSandboxApi();
    const exec = createSandboxExecBackend(api);

    const a = exec.spawn({ command: "bash", args: ["-c", "echo hi"] });
    const b = exec.spawn({ command: "bash", args: ["-c", "echo hi"] }); // identical
    const c = exec.spawn({ command: "bash", args: ["-c", "echo hi"] }); // identical

    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("concurrent identical spawns each resolve independently (no orphaned hang)", async () => {
    // Each spawn's waitForExit must resolve with ITS OWN result even when three
    // identical commands run at once. Distinct per-call exit codes prove no
    // handle was overwritten/orphaned.
    const api = createFakeSandboxApi();
    let n = 0;
    api.whenExecute(() => ({ stdout: `out${n}`, stderr: "", exitCode: n++ }));
    const exec = createSandboxExecBackend(api);

    const terms = [0, 1, 2].map(() => exec.spawn({ command: "bash", args: ["-c", "x"] }));
    // All three must resolve (a hang would time the test out).
    const exits = await Promise.all(terms.map((t) => t.waitForExit()));

    expect(exits.map((e) => e.exitCode).sort()).toEqual([0, 1, 2]);
  });
});
