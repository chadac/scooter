// How a GitLab link reads: "!N" for an MR, "#N" for an issue, before the title.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import GitLabLinkView, { gitlabReference } from "./LinkView";

const text = (url: string, title?: string) =>
  renderToStaticMarkup(createElement(GitLabLinkView, { link: { source: "gitlab", resourceType: "merge_request", url, title } }))
    .replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

describe("gitlab link view", () => {
  it("reads GitLab's reference from MR, issue and work item URLs", () => {
    expect(gitlabReference("https://gitlab.com/group/sub/proj/-/merge_requests/42")).toBe("!42");
    expect(gitlabReference("https://gitlab.com/group/proj/-/merge_requests/42/diffs")).toBe("!42");
    expect(gitlabReference("https://gitlab.com/group/proj/-/issues/9")).toBe("#9");
    expect(gitlabReference("https://gitlab.com/group/proj/-/work_items/9")).toBe("#9");
    expect(gitlabReference("https://gitlab.com/group/proj")).toBeUndefined();
  });

  it("puts the reference before the title, unless the title has it", () => {
    expect(text("https://gitlab.com/g/p/-/merge_requests/42", "fix: y")).toBe("|!42|fix: y|");
    expect(text("https://gitlab.com/g/p/-/merge_requests/42")).toBe("|!42|GitLab merge request|");
    expect(text("https://gitlab.com/g/p/-/merge_requests/42", "g/p !42")).toBe("|g/p !42|");
  });
});
