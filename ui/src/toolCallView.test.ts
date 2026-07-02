/**
 * UI unit test — the tool-call → provider-visual matcher.
 *
 * Keys off goose's title string (what arrives as toolName) + the provider's arg
 * key; disambiguates the three "comment" tools (which share a `body`). Anything
 * else returns null (→ generic ToolFallback).
 */

import { describe, it, expect } from "vitest";

import { matchToolCall, normalizeToolName, resultStatusText } from "./toolCallView.js";

describe("resultStatusText", () => {
  it("unwraps the ACP content-array result (what slack_respond returns)", () => {
    // The ugly blob the user saw: [{content:{text:"Posted to the Slack thread."}}]
    const r = [{ content: { text: "Posted to the Slack thread.", type: "text" }, type: "content" }];
    expect(resultStatusText(r)).toBe("Posted to the Slack thread.");
  });

  it("handles a plain string, {text}, and MCP {content:[{text}]}", () => {
    expect(resultStatusText("done")).toBe("done");
    expect(resultStatusText({ text: "ok" })).toBe("ok");
    expect(resultStatusText({ content: [{ type: "text", text: "posted" }] })).toBe("posted");
  });

  it("returns '' (not a JSON blob) for null/unrecognized shapes", () => {
    expect(resultStatusText(null)).toBe("");
    expect(resultStatusText(undefined)).toBe("");
    expect(resultStatusText({ weird: 1 })).toBe("");
  });
});

describe("matchToolCall", () => {
  it("matches the REAL goose form 'Scooter-env: Slack Respond' (server-prefixed, title-cased)", () => {
    // This is what actually arrives — the MCP server name + the title-cased tool
    // name — NOT the registerTool `title`. The regression the card was missing on.
    const v = matchToolCall("Scooter-env: Slack Respond", { text: "on it" });
    expect(v).toMatchObject({ provider: "slack", body: "on it" });
  });

  it("matches the server-prefixed form for each comment tool", () => {
    expect(matchToolCall("Scooter-env: Github Comment", { body: "LGTM" })).toMatchObject({ provider: "github" });
    expect(matchToolCall("Scooter-env: Gitlab Comment", { body: "x" })).toMatchObject({ provider: "gitlab" });
    expect(matchToolCall("Scooter-env: Jira Comment", { body: "x" })).toMatchObject({ provider: "jira" });
  });

  it("also matches a raw tool name and the registerTool title (fallbacks)", () => {
    expect(matchToolCall("slack_respond", { text: "hi" })).toMatchObject({ provider: "slack" });
    expect(matchToolCall("Respond in the Slack thread", { text: "hi" })).toMatchObject({ provider: "slack" });
  });

  it("maps slack_react to a slack card, reading the `emoji` arg", () => {
    expect(matchToolCall("Scooter-env: Slack React", { emoji: "eyes" })).toMatchObject({
      provider: "slack", body: "eyes",
    });
    expect(matchToolCall("React to the Slack message", { emoji: "tada" })).toMatchObject({ provider: "slack" });
    expect(matchToolCall("slack_react", { emoji: "white_check_mark" })?.action).toMatch(/react/i);
  });

  it("normalizeToolName strips the server prefix + casing to the tool identity", () => {
    expect(normalizeToolName("Scooter-env: Slack Respond")).toBe("slack_respond");
    expect(normalizeToolName("slack_respond")).toBe("slack_respond");
    expect(normalizeToolName("Github Comment")).toBe("github_comment");
  });

  it("maps the Slack respond tool to a slack card, reading `text`", () => {
    const v = matchToolCall("Respond in the Slack thread", { text: "on it 👍" });
    expect(v).toMatchObject({ provider: "slack", body: "on it 👍" });
    expect(v?.action).toMatch(/slack/i);
  });

  it("maps each comment tool to its provider, reading `body`", () => {
    expect(matchToolCall("Comment on the GitHub PR/issue", { body: "LGTM" })).toMatchObject({
      provider: "github", body: "LGTM",
    });
    expect(matchToolCall("Comment on the GitLab MR", { body: "nit: rename" })).toMatchObject({
      provider: "gitlab", body: "nit: rename",
    });
    expect(matchToolCall("Comment on the Jira issue", { body: "done" })).toMatchObject({
      provider: "jira", body: "done",
    });
  });

  it("returns null for tools we don't specialize (web search, modify_environment, unknown)", () => {
    expect(matchToolCall("Search the web (DuckDuckGo)", { query: "x" })).toBeNull();
    expect(matchToolCall("Modify the dev environment", { module_nix: "{}" })).toBeNull();
    expect(matchToolCall("Some Random Tool", { x: 1 })).toBeNull();
  });

  it("maps a Shell/command tool to a shell card, reading the `command` arg", () => {
    expect(matchToolCall("Shell", { command: "ls -la" })).toMatchObject({ provider: "shell", body: "ls -la" });
    // goose's "run: <cmd>" title and a raw run_* name both count as shell.
    expect(matchToolCall("run ls", { command: "ls" })).toMatchObject({ provider: "shell", body: "ls" });
    expect(matchToolCall("Scooter-env: Shell", { command: "echo hi" })).toMatchObject({ provider: "shell" });
    expect(matchToolCall("Shell", {})?.body).toBe(""); // missing command → empty, not a crash
    // goose titles the shell tool "run: <cmd>" — normalizeToolName strips at the
    // colon (dropping "run"), so we must match the RAW name too. The command still
    // comes from args (TOOL_CALL_ARGS), not the title. This exact case broke e2e.
    expect(matchToolCall("run: echo zxcvbnm-marker", { command: "echo zxcvbnm-marker" })).toMatchObject({
      provider: "shell", body: "echo zxcvbnm-marker",
    });
    // Even with NO name signal, a `command` arg alone marks it a shell/command tool.
    expect(matchToolCall("Some Tool", { command: "ls" })).toMatchObject({ provider: "shell", body: "ls" });
  });

  it("tolerates missing/garbage args (empty body, not a crash)", () => {
    expect(matchToolCall("Respond in the Slack thread", undefined)).toMatchObject({ provider: "slack", body: "" });
    expect(matchToolCall("Comment on the Jira issue", { notBody: 1 })).toMatchObject({ provider: "jira", body: "" });
  });
});
