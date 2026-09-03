/**
 * The policy that keeps an unwired tool from hanging the turn.
 *
 * Regression guard for: a built-in in neither the alias nor allow list was callable
 * but unwired, so it raised a permission prompt in a headless subprocess nobody could
 * answer — the turn stalled and readMessages threw `stop_reason=tool_use`.
 */
import { describe, it, expect } from "vitest";

import { decideTool, TOOL_REDIRECTS } from "./toolPolicy.js";

const ALIASES = ["mcp__sandbox__bash", "mcp__sandbox__glob"];

describe("decideTool", () => {
  it("DENIES an unknown tool rather than letting it prompt", () => {
    // THE bug: a built-in shipped by a newer CLI lands here. Denying cleanly is the
    // whole point — allowing it to prompt is what hung the turn.
    const d = decideTool("SomeToolFromANewerCLI", ALIASES);
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toMatch(/not available/i);
    expect(d.allow === false && d.reason).toMatch(/do not retry/i);
  });

  it("redirects each unsupported built-in to its scooter-env equivalent", () => {
    for (const [tool, expected] of Object.entries(TOOL_REDIRECTS)) {
      const d = decideTool(tool, ALIASES);
      expect(d.allow, `${tool} must be denied`).toBe(false);
      expect(d.allow === false && d.reason).toBe(expected);
    }
  });

  it("names the replacement, so the model can self-correct", () => {
    expect(decideTool("WebSearch", ALIASES)).toMatchObject({ reason: /web_search/ });
    expect(decideTool("WebFetch", ALIASES)).toMatchObject({ reason: /web_fetch/ });
    expect(decideTool("Task", ALIASES)).toMatchObject({ reason: /spawn_subagent/ });
  });

  it("tells AskUserQuestion to state the question and proceed, not block @proves", () => {
    const d = decideTool("AskUserQuestion", ALIASES);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/state the question/i);
    expect(d.reason).toMatch(/continue|proceeding/i);
  });

  it("allows ToolSearch — the scooter-env tools are deferred and need discovery @proves", () => {
    // Denying it leaves the model holding an allowlist entry for a toolset it cannot
    // enumerate, so it falls back on built-ins that are themselves denied.
    expect(decideTool("ToolSearch", ALIASES).allow).toBe(true);
  });

  it("allows TodoWrite (pure in-process state)", () => {
    expect(decideTool("TodoWrite", ALIASES).allow).toBe(true);
  });

  it("allows every mcp__ tool — sandbox, scooter-env, and BYOC-tunnelled servers", () => {
    expect(decideTool("mcp__sandbox__bash", []).allow).toBe(true);
    expect(decideTool("mcp__scooter-env__list_models", []).allow).toBe(true);
    expect(decideTool("mcp__some-byoc-server__thing", []).allow).toBe(true);
  });

  it("allows the aliased tool names themselves", () => {
    expect(decideTool("mcp__sandbox__glob", ALIASES).allow).toBe(true);
  });

  it("tells a LOCAL built-in to use its sandbox alias", () => {
    // Bash/Glob/etc. are disallowed at the SDK layer, but if one reaches the hook the
    // reason should say why rather than give the generic refusal: running it here would
    // execute in the agent-host pod, not the conversation's workspace.
    const d = decideTool("Bash", ALIASES);
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toMatch(/sandbox/i);
  });

  it("denies NotebookEdit without inventing a replacement", () => {
    const d = decideTool("NotebookEdit", ALIASES);
    expect(d.allow).toBe(false);
    // marimo notebooks are .py — the sandbox edit tool already covers them.
    expect(d.allow === false && d.reason).toMatch(/edit/i);
  });
});
