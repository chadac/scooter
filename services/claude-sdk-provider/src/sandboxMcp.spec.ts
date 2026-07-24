/**
 * Tier 1 contract test — the SDK claude-code provider's sandbox MCP tools.
 *
 * These are what claude's built-in Bash/Read/Edit/Write are redirected to. The
 * product assertion: they exec via the ExecBackend → the SANDBOX pod (not the
 * agent-host), the exact fix for the "tools ran in the wrong pod, scooter-rebuild
 * unreachable" bug. Tested against a fake ExecBackend, no SDK runtime.
 */

import { describe, it, expect } from "vitest";

import { sandboxToolHandlers, TOOL_ALIASES, DISABLED_BUILTINS } from "./sandboxMcp.js";
import type { ExecBackend, ExecRequest, TerminalHandle } from "./types.js";

/** A fake ExecBackend recording spawn requests + serving canned file contents. */
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
    // Ran via the ExecBackend (the sandbox), with a login shell, cwd /workspace.
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
    // The wiring the SDK query() options need to route claude's Bash into the sandbox.
    expect(TOOL_ALIASES.Bash).toBe("mcp__sandbox__bash");
    expect(TOOL_ALIASES.Read).toBe("mcp__sandbox__read");
    expect(DISABLED_BUILTINS).toEqual(["Bash", "Read", "Edit", "Write"]);
  });
});
