/**
 * Tier 1 contract test for the claude-code provider's sandbox MCP tools: they must
 * exec via the ExecBackend into the sandbox pod, tested against a fake ExecBackend
 * with no SDK runtime.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { sandboxToolHandlers, TOOL_ALIASES, DISABLED_BUILTINS, IMAGE_MAX_BYTES, imageMimeType, BASH_TIMEOUT_MAX_S } from "./sandboxMcp.js";

/** The injection canary, created only if the quoting fails. */
const CANARY = "/tmp/scooter-injection-canary";

/** Mirrors sandboxMcp's internal `shq`; the round-trip assertion below proves the idiom. */
const shquoteForTest = (v: string): string => "'" + v.replace(/'/g, "'\\''") + "'";
import type { ExecBackend, ExecRequest, TerminalHandle } from "./types.js";

/** A fake ExecBackend recording spawn requests and serving canned file contents. */
function fakeExec(opts?: {
  exitCode?: number;
  output?: string;
  files?: Record<string, string>;
}) {
  const spawns: ExecRequest[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const files = { ...(opts?.files ?? {}) };
  const exec: ExecBackend = {
    async run(): Promise<never> {
      throw new Error("not used");
    },
    spawn(req: ExecRequest): TerminalHandle {
      spawns.push(req);
      const cbs = new Set<(c: string) => void>();
      return {
        id: `t-${spawns.length}`,
        onOutput(cb) {
          cbs.add(cb);
          if (opts?.output) cb(opts.output);
        },
        async waitForExit() {
          return { exitCode: opts?.exitCode ?? 0 };
        },
        async kill() {},
        async release() {},
      };
    },
    async readTextFile(path: string) {
      if (!(path in files)) throw new Error(`no such file: ${path}`);
      return files[path];
    },
    async writeTextFile(path: string, content: string) {
      files[path] = content;
      writes.push({ path, content });
    },
  };
  return { exec, spawns, writes, files };
}

describe("sandbox MCP tool handlers", () => {
  it("bash execs the command in the sandbox under /workspace and returns stdout", async () => {
    const { exec, spawns } = fakeExec({ output: "hi\n" });
    const h = sandboxToolHandlers(exec);
    const res = await h.bash({ command: "echo hi" });
    expect(res.content[0].text).toBe("hi\n");
    expect(res.isError).toBeUndefined();
    // Ran via the ExecBackend with a login shell under /workspace.
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ command: "sh", args: ["-lc", "echo hi"], cwd: "/workspace" });
  });

  it("bash surfaces a non-zero exit as an error result carrying the output", async () => {
    const { exec } = fakeExec({ output: "nope\n", exitCode: 2 });
    const res = await sandboxToolHandlers(exec).bash({ command: "false" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("nope");
    expect(res.content[0].text).toContain("[exit 2]");
  });

  it("bash passes a requested timeout to the exec as milliseconds, and none by default", async () => {
    const { exec, spawns } = fakeExec();
    const h = sandboxToolHandlers(exec);
    await h.bash({ command: "make", timeout: 900 });
    await h.bash({ command: "ls" });
    expect(spawns[0].timeoutMs).toBe(900_000);
    expect(spawns[1].timeoutMs).toBeUndefined();
  });

  it("bash rejects a non-positive or over-max timeout without running anything", async () => {
    const { exec, spawns } = fakeExec();
    const h = sandboxToolHandlers(exec);
    for (const timeout of [0, -5, BASH_TIMEOUT_MAX_S + 1, Number.NaN]) {
      const res = await h.bash({ command: "ls", timeout });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/timeout must be/);
    }
    expect(spawns).toHaveLength(0);
  });

  it("bash keeps an absolute /workspace cwd but ignores an agent-host-pod cwd", async () => {
    const { exec, spawns } = fakeExec();
    const h = sandboxToolHandlers(exec);
    await h.bash({ command: "ls", cwd: "/workspace/sub" });
    await h.bash({ command: "ls", cwd: "/root/host-path" });
    expect(spawns[0].cwd).toBe("/workspace/sub");
    expect(spawns[1].cwd).toBe("/workspace");
  });

  it("read returns the sandbox file contents", async () => {
    const { exec } = fakeExec({ files: { "/workspace/a.txt": "content" } });
    const res = await sandboxToolHandlers(exec).read({ path: "/workspace/a.txt" });
    expect(res.content[0].text).toBe("content");
  });

  it("read errors cleanly on a missing file", async () => {
    const { exec } = fakeExec();
    const res = await sandboxToolHandlers(exec).read({ path: "/nope" });
    expect(res.isError).toBe(true);
  });

  it("write creates the sandbox file", async () => {
    const { exec, files } = fakeExec();
    const res = await sandboxToolHandlers(exec).write({ path: "/workspace/new.txt", content: "x" });
    expect(res.isError).toBeUndefined();
    expect(files["/workspace/new.txt"]).toBe("x");
  });

  it("edit replaces a unique string in the sandbox file", async () => {
    const { exec, files } = fakeExec({ files: { "/etc/scooter/modules/m.nix": "a OLD b" } });
    const res = await sandboxToolHandlers(exec).edit({ path: "/etc/scooter/modules/m.nix", old_string: "OLD", new_string: "NEW" });
    expect(res.isError).toBeUndefined();
    expect(files["/etc/scooter/modules/m.nix"]).toBe("a NEW b");
  });

  it("edit rejects a non-unique old_string", async () => {
    const { exec } = fakeExec({ files: { "/f": "x x" } });
    const res = await sandboxToolHandlers(exec).edit({ path: "/f", old_string: "x", new_string: "y" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not unique");
  });

  it("edit rejects a missing old_string", async () => {
    const { exec } = fakeExec({ files: { "/f": "abc" } });
    const res = await sandboxToolHandlers(exec).edit({ path: "/f", old_string: "zzz", new_string: "y" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not found");
  });

  it("exposes the built-in→sandbox alias map + the disabled built-ins list", () => {
    expect(TOOL_ALIASES.Bash).toBe("mcp__sandbox__bash");
    expect(TOOL_ALIASES.Read).toBe("mcp__sandbox__read");
    expect(TOOL_ALIASES.Glob).toBe("mcp__sandbox__glob");
    expect(TOOL_ALIASES.Grep).toBe("mcp__sandbox__grep");
    // Every aliased built-in must also be disabled, or the model can call the local one.
    expect(DISABLED_BUILTINS).toEqual(expect.arrayContaining(Object.keys(TOOL_ALIASES)));
    // The native subagent tools are hidden too, so the model reaches for spawn_subagent, whose subagents the UI shows.
    expect(DISABLED_BUILTINS).toEqual(expect.arrayContaining(["Task", "Agent"]));
  });
});

/** The two search tools must exec in the sandbox and must not escape /workspace. */
describe("sandbox glob + grep", () => {
  it("glob execs in the sandbox and confines the search to /workspace", async () => {
    const { exec, spawns } = fakeExec({ output: "/workspace/a.ts\n/workspace/b.ts\n" });
    const res = await sandboxToolHandlers(exec).glob({ pattern: "**/*.ts" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("/workspace/a.ts");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe("sh");
    expect(spawns[0]!.args?.[1]).toContain("/workspace");
  });

  it("glob REFUSES to search outside /workspace", async () => {
    // sandboxCwd() pins a cwd outside the workspace back to /workspace.
    const { exec, spawns } = fakeExec({ output: "" });
    await sandboxToolHandlers(exec).glob({ pattern: "*.ts", path: "/etc" });
    expect(spawns[0]!.args?.[1]).not.toContain("'/etc'");
    expect(spawns[0]!.args?.[1]).toContain("/workspace");
  });

  it("glob caps its output so a huge tree cannot flood the context", async () => {
    const { exec, spawns } = fakeExec({ output: "" });
    await sandboxToolHandlers(exec).glob({ pattern: "*" });
    expect(spawns[0]!.args?.[1]).toMatch(/head -n \d+/);
  });

  it("glob reports NO MATCH distinctly from an error", async () => {
    const { exec } = fakeExec({ output: "" });
    const res = await sandboxToolHandlers(exec).glob({ pattern: "*.nope" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toMatch(/no files match/i);
  });

  it("grep returns file:line:text and prefers rg when present", async () => {
    const { exec, spawns } = fakeExec({ output: "/workspace/a.ts:12:const x = 1\n" });
    const res = await sandboxToolHandlers(exec).grep({ pattern: "const x" });

    expect(res.content[0]!.text).toContain("a.ts:12:");
    const script = spawns[0]!.args?.[1] ?? "";
    expect(script).toContain("command -v rg");
    expect(script).toContain("/workspace");
  });

  it("grep quotes the pattern, so shell metacharacters cannot inject", async () => {
    const { exec, spawns } = fakeExec({ output: "" });
    // Every shape that would break out of the argument, kept inert if the escaping ever regresses.
    const evil = `'; touch ${CANARY}; $(id); echo '`;
    rmSync(CANARY, { force: true }); // a leftover would fake a pass
    await sandboxToolHandlers(exec).grep({ pattern: evil });
    const script = spawns[0]!.args?.[1] ?? "";

    // The payload text appears inside quotes, so assert the escaping: every embedded quote is closed-escaped-reopened ('\'').
    expect(script).toContain("'\\''");
    // Prove inertness by execution: a real sh must hand the payload back as one literal argument.
    const quotedPattern = shquoteForTest(evil);
    const roundTripped = execFileSync("sh", ["-lc", `printf '%s' ${quotedPattern}`]).toString();
    expect(roundTripped).toBe(evil);
    expect(script).toContain(quotedPattern);

    // If the escaping broke, the embedded `touch` ran during the printf above.
    expect(existsSync(CANARY)).toBe(false);
  });

  it("both reject an empty pattern instead of listing the whole tree", async () => {
    const { exec } = fakeExec();
    expect((await sandboxToolHandlers(exec).glob({ pattern: "  " })).isError).toBe(true);
    expect((await sandboxToolHandlers(exec).grep({ pattern: "" })).isError).toBe(true);
  });
});

/** Image reads: the agent must be able to SEE a screenshot it took in its own sandbox. */
describe("sandbox read of images", () => {
  /** An ExecBackend whose run() executes the script on this host, so the real stat/base64 pipeline is exercised. */
  function hostRunExec(): { exec: ExecBackend; runs: ExecRequest[] } {
    const runs: ExecRequest[] = [];
    const { exec: base } = fakeExec();
    const exec: ExecBackend = {
      ...base,
      async run(req: ExecRequest) {
        runs.push(req);
        const r = spawnSync(req.command, req.args, { encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
    };
    return { exec, runs };
  }

  // A 1x1 transparent PNG.
  const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("returns a .png as an image block the model can see", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scooter-img-"));
    const path = join(dir, "it's a screenshot.PNG"); // quote + case exercise the quoting and mime lookup
    writeFileSync(path, Buffer.from(PNG_B64, "base64"));
    const { exec, runs } = hostRunExec();
    const res = await sandboxToolHandlers(exec).read({ path });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/png" }]);
    // Bytes travel as base64 over exec, never through the text download path.
    expect(runs).toHaveLength(1);
  });

  it("refuses an image over the API limit without shipping it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scooter-img-"));
    const path = join(dir, "huge.jpg");
    writeFileSync(path, Buffer.alloc(IMAGE_MAX_BYTES + 1));
    const { exec } = hostRunExec();
    const res = await sandboxToolHandlers(exec).read({ path });
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect((res.content[0] as { text: string }).text).toMatch(/downscale/);
  });

  it("errors cleanly on a missing image", async () => {
    const { exec } = hostRunExec();
    const res = await sandboxToolHandlers(exec).read({ path: "/nonexistent/shot.png" });
    expect(res.isError).toBe(true);
  });

  it("still reads non-image files as text", async () => {
    const { exec } = fakeExec({ files: { "/workspace/notes.md": "# hi" } });
    const res = await sandboxToolHandlers(exec).read({ path: "/workspace/notes.md" });
    expect(res.content).toEqual([{ type: "text", text: "# hi" }]);
  });

  it("maps the supported extensions to mime types", () => {
    expect(imageMimeType("/a/b.png")).toBe("image/png");
    expect(imageMimeType("/a/b.JPEG")).toBe("image/jpeg");
    expect(imageMimeType("/a/b.jpg")).toBe("image/jpeg");
    expect(imageMimeType("/a/b.gif")).toBe("image/gif");
    expect(imageMimeType("/a/b.webp")).toBe("image/webp");
    expect(imageMimeType("/a/b.svg")).toBeUndefined();
    expect(imageMimeType("/a/png")).toBeUndefined();
  });
});
