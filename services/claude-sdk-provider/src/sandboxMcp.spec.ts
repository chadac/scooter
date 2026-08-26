/**
 * Tier 1 contract test — the SDK claude-code provider's sandbox MCP tools.
 *
 * These are what claude's built-in Bash/Read/Edit/Write are redirected to. The
 * product assertion: they exec via the ExecBackend → the SANDBOX pod (not the
 * agent-host), the exact fix for the "tools ran in the wrong pod, scooter-rebuild
 * unreachable" bug. Tested against a fake ExecBackend, no SDK runtime.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { sandboxToolHandlers, TOOL_ALIASES, DISABLED_BUILTINS } from "./sandboxMcp.js";

/** Mirrors sandboxMcp's internal `shq` (not exported). Kept identical on purpose: the
 *  round-trip assertion below is what proves the idiom is right. */
/** The injection canary: created only if the quoting fails, so its absence is proof. */
const CANARY = "/tmp/scooter-injection-canary";

const shquoteForTest = (v: string): string => "'" + v.replace(/'/g, "'\\''") + "'";
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
    expect(TOOL_ALIASES.Glob).toBe("mcp__sandbox__glob");
    expect(TOOL_ALIASES.Grep).toBe("mcp__sandbox__grep");
    // EVERY aliased built-in must also be disabled, or the model can call the local one
    // and it runs in the agent-host pod instead of the sandbox. Derived rather than
    // hard-coded, so adding an alias without disabling it fails here.
    expect([...DISABLED_BUILTINS].sort()).toEqual(Object.keys(TOOL_ALIASES).sort());
  });
});

/**
 * glob + grep: the two search tools. They were previously UNWIRED — the model could
 * call the local built-ins, which raised a headless permission prompt and hung the
 * turn (see toolPolicy.ts). Same product assertion as the rest of this file: they must
 * exec in the SANDBOX, and must not escape /workspace.
 */
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
    // A cwd outside the workspace does not exist in the sandbox; sandboxCwd() pins it.
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
    expect(res.isError).toBeFalsy(); // no match is not a failure
    expect(res.content[0]!.text).toMatch(/no files match/i);
  });

  it("grep returns file:line:text and prefers rg when present", async () => {
    const { exec, spawns } = fakeExec({ output: "/workspace/a.ts:12:const x = 1\n" });
    const res = await sandboxToolHandlers(exec).grep({ pattern: "const x" });

    expect(res.content[0]!.text).toContain("a.ts:12:");
    const script = spawns[0]!.args?.[1] ?? "";
    expect(script).toContain("command -v rg"); // falls back to grep -rnI otherwise
    expect(script).toContain("/workspace");
  });

  it("grep quotes the pattern, so shell metacharacters cannot inject", async () => {
    const { exec, spawns } = fakeExec({ output: "" });
    // A quote-escape + command-separator + subshell, i.e. every shape that would break
    // out of the argument — but deliberately INERT if the escaping ever regressed. A
    // destructive payload would prove the same thing while doing real damage on failure,
    // which is a bad trade for a unit test.
    const evil = `'; touch ${CANARY}; $(id); echo '`;
    rmSync(CANARY, { force: true }); // a leftover from an earlier run would fake a pass
    await sandboxToolHandlers(exec).grep({ pattern: evil });
    const script = spawns[0]!.args?.[1] ?? "";

    // The payload TEXT does appear — inside quotes, which is fine. What matters is that
    // it is INERT, so assert the escaping, not the absence of the substring: every
    // embedded quote must be closed-escaped-reopened ('\''), the POSIX idiom that keeps
    // sh treating the whole thing as one literal argument.
    expect(script).toContain("'\\''");
    // Prove INERTNESS by execution, not by pattern-matching the script text — text
    // matching cannot tell "dangerous" from "harmless inside quotes", and an earlier
    // version of this test got exactly that wrong. Feed the same quoting to a real sh
    // and require the payload back as ONE literal argument.
    const quotedPattern = shquoteForTest(evil);
    const roundTripped = execFileSync("sh", ["-lc", `printf '%s' ${quotedPattern}`]).toString();
    expect(roundTripped).toBe(evil);
    expect(script).toContain(quotedPattern);

    // The canary's ABSENCE is the direct evidence: if the escaping broke, the embedded
    // `touch` would have run during the printf above and this file would exist.
    expect(existsSync(CANARY)).toBe(false);
  });

  it("both reject an empty pattern instead of listing the whole tree", async () => {
    const { exec } = fakeExec();
    expect((await sandboxToolHandlers(exec).glob({ pattern: "  " })).isError).toBe(true);
    expect((await sandboxToolHandlers(exec).grep({ pattern: "" })).isError).toBe(true);
  });
});
