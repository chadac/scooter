/** Hook parsing, Claude Code's protocol, and the runner against a fake exec. */

import { describe, it, expect } from "vitest";

import { createHookRunner, interpret, matches, merge, parseHooks } from "../../src/hooks/runner.js";
import type { HookDef } from "../../src/hooks/types.js";
import type { ExecBackend, ExecRequest, ExecResult } from "../../src/types.js";

const hook = (over: Partial<HookDef>): HookDef => ({
  id: "h",
  event: "Stop",
  matcher: "",
  command: "true",
  timeoutSec: 30,
  failClosed: false,
  userCanDisable: false,
  description: "",
  ...over,
});

/** An ExecBackend recording each request. */
const fakeExec = (answer: (req: ExecRequest, signal?: AbortSignal) => Promise<ExecResult> | ExecResult) => {
  const calls: ExecRequest[] = [];
  const exec = {
    run: async (req: ExecRequest, signal?: AbortSignal) => {
      calls.push(req);
      return answer(req, signal);
    },
  } as unknown as ExecBackend;
  return { exec, calls };
};
const ok = (stdout = "", exitCode = 0, stderr = ""): ExecResult => ({ stdout, stderr, exitCode });

describe("parseHooks (AGENT_HOOKS_JSON)", () => {
  it("keeps well-formed rows, defaults the optional fields and drops the rest", () => {
    const warns: string[] = [];
    const out = parseHooks(
      JSON.stringify([
        { id: "a", event: "Stop", command: "exit 0" },
        { id: "b", event: "Nope", command: "x" },
        { id: "c", event: "PreToolUse", command: "  " },
        { id: "d", event: "PreToolUse", command: "x", matcher: "(" },
        { id: "e", event: "PreToolUse", command: "x", matcher: "Bash", timeoutSec: 5, failClosed: true, userCanDisable: true },
      ]),
      (m) => warns.push(m),
    );
    expect(out.map((h) => h.id)).toEqual(["a", "e"]);
    expect(out[0]).toMatchObject({ matcher: "", timeoutSec: 30, failClosed: false, userCanDisable: false });
    expect(out[1]).toMatchObject({ matcher: "Bash", timeoutSec: 5, failClosed: true, userCanDisable: true });
    expect(warns).toHaveLength(3);
  });

  it("is empty for unset or invalid JSON", () => {
    expect(parseHooks(undefined)).toEqual([]);
    expect(parseHooks("{")).toEqual([]);
    expect(parseHooks("{}")).toEqual([]);
  });
});

describe("matches (Claude Code matcher)", () => {
  it("treats empty and * as everything and anchors a regex", () => {
    expect(matches("", undefined)).toBe(true);
    expect(matches("*", "Bash")).toBe(true);
    expect(matches("Bash|Edit", "Edit")).toBe(true);
    expect(matches("Bash", "mcp__sandbox__bash")).toBe(false);
    expect(matches("mcp__.*", "mcp__github__x")).toBe(true);
    expect(matches("Bash", undefined)).toBe(false);
  });
});

describe("interpret (Claude Code hook output)", () => {
  it("blocks on exit 2 with stderr as the reason", () => {
    expect(interpret("Stop", ok("", 2, "push first"))).toMatchObject({ decision: "block", block: "push first" });
  });

  it("reports any other non-zero exit as a non-blocking error", () => {
    expect(interpret("Stop", ok("", 1, "boom"))).toMatchObject({ decision: "error", error: "boom" });
  });

  it("reads decision/reason, additionalContext, systemMessage and continue:false", () => {
    expect(interpret("Stop", ok(JSON.stringify({ decision: "block", reason: "r", systemMessage: "hi" })))).toMatchObject({
      decision: "block",
      block: "r",
      systemMessage: "hi",
    });
    expect(
      interpret("PostToolUse", ok(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "lint failed" } }))),
    ).toMatchObject({ decision: "allow", context: "lint failed" });
    expect(interpret("Stop", ok(JSON.stringify({ continue: false, stopReason: "budget" })))).toMatchObject({ decision: "stop", stop: "budget" });
  });

  it("reads a PreToolUse deny and an input rewrite", () => {
    const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } };
    expect(interpret("PreToolUse", ok(JSON.stringify(deny)))).toMatchObject({ decision: "block", block: "no" });
    const rewrite = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "ls" } } };
    expect(interpret("PreToolUse", ok(JSON.stringify(rewrite)))).toMatchObject({ decision: "allow", updatedInput: { command: "ls" } });
  });

  it("treats plain stdout as context only for UserPromptSubmit and SessionStart", () => {
    expect(interpret("UserPromptSubmit", ok("today is Tuesday\n"))).toMatchObject({ context: "today is Tuesday" });
    expect(interpret("Stop", ok("chatter")).context).toBeUndefined();
  });
});

describe("merge", () => {
  it("joins every block and drops a rewrite when anything blocks", () => {
    const out = merge([
      { id: "a", decision: "allow", updatedInput: { x: 1 } },
      { id: "b", decision: "block", block: "one" },
      { id: "c", decision: "block", block: "two" },
    ]);
    expect(out.block).toBe("one\n\ntwo");
    expect(out.updatedInput).toBeUndefined();
  });
});

describe("createHookRunner", () => {
  it("runs matching hooks in the sandbox with the event JSON on stdin", async () => {
    const { exec, calls } = fakeExec(() => ok());
    const runner = createHookRunner({
      exec,
      hooks: [hook({ id: "pre", event: "PreToolUse", matcher: "Bash" }), hook({ id: "stop" })],
    });
    await runner.run("PreToolUse", { tool_name: "Edit" }, "Edit");
    expect(calls).toHaveLength(0);
    const out = await runner.run("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }, "Bash");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "bash", args: ["-c", "true"], cwd: "/workspace" });
    expect(calls[0].env).toMatchObject({ SCOOTER_HOOK_ID: "pre", SCOOTER_HOOK_EVENT: "PreToolUse" });
    expect(JSON.parse(calls[0].stdin!)).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/workspace" });
    expect(out.runs).toEqual([expect.objectContaining({ id: "pre", decision: "allow" })]);
  });

  it("skips a broken hook unless it is fail-closed", async () => {
    const { exec } = fakeExec(() => ok("", 1, "crashed"));
    const open = await createHookRunner({ exec, hooks: [hook({})] }).run("Stop", {});
    expect(open.block).toBeUndefined();
    expect(open.runs[0]).toMatchObject({ decision: "error", error: "crashed" });
    const closed = await createHookRunner({ exec, hooks: [hook({ failClosed: true })] }).run("Stop", {});
    expect(closed.block).toMatch(/Hook h failed \(crashed\)/);
  });

  it("aborts a hook past its timeout", async () => {
    const { exec } = fakeExec(
      (_req, signal) =>
        new Promise((resolve) => signal?.addEventListener("abort", () => resolve(ok("", 130, "aborted")), { once: true })),
    );
    const out = await createHookRunner({ exec, hooks: [hook({ timeoutSec: 0.01 })] }).run("Stop", {});
    expect(out.runs[0]).toMatchObject({ decision: "error", error: "timed out after 0.01s" });
  });

  it("leaves out a hook the owner turned off, but only when it may be turned off", async () => {
    const { exec, calls } = fakeExec(() => ok());
    const runner = createHookRunner({
      exec,
      hooks: [hook({ id: "optional", userCanDisable: true }), hook({ id: "required" })],
      disabled: async () => new Set(["optional", "required"]),
    });
    expect(await runner.has("Stop")).toBe(true);
    await runner.run("Stop", {});
    expect(calls.map((c) => c.env?.SCOOTER_HOOK_ID)).toEqual(["required"]);
  });

  it("keeps every hook on when the opt-out lookup fails", async () => {
    const { exec, calls } = fakeExec(() => ok());
    const runner = createHookRunner({
      exec,
      hooks: [hook({ id: "optional", userCanDisable: true })],
      disabled: async () => {
        throw new Error("db down");
      },
    });
    await runner.run("Stop", {});
    expect(calls).toHaveLength(1);
  });
});

describe("hook preconditions (when)", () => {
  it("skips the exec unless the event's scooter facts satisfy it", async () => {
    const { exec, calls } = fakeExec(() => ok("", 2, "name it"));
    const runner = createHookRunner({ exec, hooks: [hook({ when: "untitled" })] });
    expect((await runner.run("Stop", { scooter: { untitled: false } })).block).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect((await runner.run("Stop", { scooter: { untitled: true } })).block).toBe("name it");
    expect(calls).toHaveLength(1);
  });

  it("runs a filed hook only in a conversation filed in a folder", async () => {
    const { exec, calls } = fakeExec(() => ok("", 2, "update the card"));
    const runner = createHookRunner({ exec, hooks: [hook({ when: "filed" })] });
    expect((await runner.run("Stop", { scooter: { folder: null } })).block).toBeUndefined();
    expect((await runner.run("Stop", { scooter: {} })).block).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect((await runner.run("Stop", { scooter: { folder: { id: "f", name: "Work" } } })).block).toBe("update the card");
    expect(calls).toHaveLength(1);
  });

  it("parses known conditions and drops rows with unknown ones", () => {
    const out = parseHooks(
      JSON.stringify([
        { id: "a", event: "Stop", command: "x", when: "untitled" },
        { id: "b", event: "Stop", command: "x", when: "sunny" },
        { id: "c", event: "Stop", command: "x", when: "filed" },
      ]),
    );
    expect(out.map((h) => [h.id, h.when])).toEqual([["a", "untitled"], ["c", "filed"]]);
  });
});
