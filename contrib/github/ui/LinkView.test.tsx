// How a GitHub link reads: "#N" before the title, unless the title already has it.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import GitHubLinkView, { githubNumber } from "./LinkView";

const text = (url: string, title?: string, resourceType = "pull_request") =>
  renderToStaticMarkup(createElement(GitHubLinkView, { link: { source: "github", resourceType, url, title } }))
    .replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

describe("github link view", () => {
  it("reads the number from PR and issue URLs", () => {
    expect(githubNumber("https://github.com/chadac-me/scooter/pull/1153")).toBe("1153");
    expect(githubNumber("https://github.com/chadac-me/scooter/pull/1153/files")).toBe("1153");
    expect(githubNumber("https://github.com/chadac-me/scooter/pull/1153#issuecomment-1")).toBe("1153");
    expect(githubNumber("https://github.com/chadac-me/scooter/issues/1117")).toBe("1117");
    expect(githubNumber("https://github.com/chadac-me/scooter")).toBeUndefined();
    expect(githubNumber(undefined)).toBeUndefined();
  });

  it("puts the number before the title", () => {
    expect(text("https://github.com/o/r/pull/7", "feat: x")).toBe("|#7|feat: x|");
  });

  it("names an untitled link by its repo", () => {
    expect(text("https://github.com/o/r/pull/7")).toBe("|#7|o/r|");
    expect(text("https://github.com/o/r/issues/7", undefined, "issue")).toBe("|#7|o/r|");
    expect(text("https://example.com/x", undefined, "issue")).toBe("|GitHub issue|");
  });

  it("leaves a title that already shows the number alone", () => {
    expect(text("https://github.com/o/app/pull/7", "o/app #7")).toBe("|o/app #7|");
    // #70 is not #7.
    expect(text("https://github.com/o/app/pull/7", "o/app #70")).toBe("|#7|o/app #70|");
  });
});
