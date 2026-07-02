/**
 * UI unit test — the tool-call → provider-visual matcher.
 *
 * Keys off goose's title string (what arrives as toolName) + the provider's arg
 * key; disambiguates the three "comment" tools (which share a `body`). Anything
 * else returns null (→ generic ToolFallback).
 */

import { describe, it, expect } from "vitest";

import { matchToolCall } from "./toolCallView.js";

describe("matchToolCall", () => {
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
    expect(matchToolCall("run ls", { command: "ls" })).toBeNull();
  });

  it("tolerates missing/garbage args (empty body, not a crash)", () => {
    expect(matchToolCall("Respond in the Slack thread", undefined)).toMatchObject({ provider: "slack", body: "" });
    expect(matchToolCall("Comment on the Jira issue", { notBody: 1 })).toMatchObject({ provider: "jira", body: "" });
  });
});
