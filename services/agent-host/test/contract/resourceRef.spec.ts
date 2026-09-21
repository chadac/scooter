/**
 * Tier 1 contract — a linked resource's URL identifies its target.
 *
 * THE OUTAGE THIS PREVENTS: every link written through the agent-host API (the broker's
 * auto-link injector, `link add`) stores an html_url and NO ref. The reply-tool
 * resolvers read `ref` first and a webhooks `owner/repo#n` id second, so a URL-form link
 * matched neither — `github_comment` was never registered and the agent had no way to
 * reply on the PR it was working on (155 of 156 live rows were in that shape). Issue #563.
 */

import { describe, it, expect } from "vitest";

import {
  canonicalResourceType,
  parseGithubUrl,
  parseGitlabUrl,
  parseJiraUrl,
  refFromUrl,
  withDerivedRef,
} from "../../src/agent/resourceRef.js";
import type { ConversationLink } from "../../src/session/manager.js";

describe("resourceRef: github URLs", () => {
  it("parses a PR url", () => {
    expect(parseGithubUrl("https://github.com/chadac/scooter/pull/561")).toEqual({
      owner: "chadac",
      repo: "scooter",
      number: 561,
    });
  });

  it("parses an issue url", () => {
    expect(parseGithubUrl("https://github.com/chadac/scooter/issues/563")).toEqual({
      owner: "chadac",
      repo: "scooter",
      number: 563,
    });
  });

  it("tolerates a deep-link suffix (a review tab, a comment anchor)", () => {
    expect(parseGithubUrl("https://github.com/o/r/pull/7/files#discussion_r1")?.number).toBe(7);
  });

  it("works on an enterprise host (the host is not part of the shape)", () => {
    expect(parseGithubUrl("https://git.acme.example/o/r/pull/9")).toMatchObject({ owner: "o", repo: "r", number: 9 });
  });

  it.each([
    "https://github.com/chadac/scooter",            // repo root — no resource
    "https://github.com/chadac/scooter/pull/abc",   // not a number
    "https://github.com/o/r/releases/tag/v1",       // another kind of page
    "chadac/scooter#561",                           // the OTHER id shape, not a url
    "not a url",
  ])("returns undefined rather than guess: %s", (input) => {
    expect(parseGithubUrl(input)).toBeUndefined();
  });
});

describe("resourceRef: gitlab URLs", () => {
  it("parses an MR url, keeping the full (subgrouped) project path", () => {
    expect(parseGitlabUrl("https://gitlab.com/group/sub/proj/-/merge_requests/12")).toEqual({
      projectId: "group/sub/proj",
      iid: "12",
      isMr: true,
    });
  });

  it("parses an issue url and marks it NOT an MR", () => {
    expect(parseGitlabUrl("https://gitlab.com/group/proj/-/issues/5")).toEqual({
      projectId: "group/proj",
      iid: "5",
      isMr: false,
    });
  });

  it("accepts the older url form without the /-/ separator", () => {
    expect(parseGitlabUrl("https://gitlab.com/group/proj/merge_requests/3")).toMatchObject({
      projectId: "group/proj",
      iid: "3",
    });
  });
});

describe("resourceRef: jira URLs", () => {
  it("parses a browse url", () => {
    expect(parseJiraUrl("https://acme.atlassian.net/browse/ENG-42")).toEqual({ issueKey: "ENG-42" });
  });

  it("returns undefined for a non-issue jira page", () => {
    expect(parseJiraUrl("https://acme.atlassian.net/jira/software/projects/ENG/boards/1")).toBeUndefined();
  });
});

describe("resourceRef: ref derivation", () => {
  it("derives a github ref from the url", () => {
    expect(refFromUrl("github", "https://github.com/o/r/pull/7")).toEqual({ owner: "o", repo: "r", number: 7 });
  });

  it("puts a gitlab ISSUE iid in `iid`, never `mrIid`", () => {
    // mrIid means "merge request N" to the resolver; an issue there would post the
    // agent's comment on an unrelated MR.
    expect(refFromUrl("gitlab", "https://gitlab.com/g/p/-/issues/5")).toEqual({ projectId: "g/p", iid: "5" });
    expect(refFromUrl("gitlab", "https://gitlab.com/g/p/-/merge_requests/5")).toEqual({ projectId: "g/p", mrIid: "5" });
  });

  it("derives nothing for an unknown source or an unparseable url", () => {
    expect(refFromUrl("slack", "https://example.com/x")).toBeUndefined();
    expect(refFromUrl("github", undefined)).toBeUndefined();
  });

  it("keeps an EXPLICIT ref — the webhooks handlers know more than a url does", () => {
    const link: ConversationLink = {
      source: "github",
      resourceType: "pull_request",
      url: "https://github.com/o/r/pull/7",
      ref: { owner: "o", repo: "r", number: 99 },
    };
    expect(withDerivedRef(link).ref).toEqual({ owner: "o", repo: "r", number: 99 });
  });

  it("fills in a missing ref from the url", () => {
    const link: ConversationLink = { source: "github", resourceType: "pr", url: "https://github.com/o/r/pull/7" };
    expect(withDerivedRef(link).ref).toEqual({ owner: "o", repo: "r", number: 7 });
  });

  it("leaves a link alone when nothing is derivable", () => {
    const link: ConversationLink = { source: "slack", resourceType: "thread", title: "#eng thread" };
    expect(withDerivedRef(link)).toEqual(link);
  });
});

describe("resourceRef: canonical resource_type", () => {
  // MUST stay in step with webhooks/resources.py `_TYPE_ALIASES` — both services write
  // resource_links, and the type is part of its unique key.
  it.each([
    ["github", "pr", "pull_request"],
    ["github", "pull_request", "pull_request"],
    ["gitlab", "mr", "merge_request"],
    ["jira", "ticket", "issue"],
    ["slack", "message", "thread"],
  ])("%s %s -> %s", (source, given, want) => {
    expect(canonicalResourceType(source, given)).toBe(want);
  });

  it("passes an unknown type through rather than mangling it into a wrong one", () => {
    expect(canonicalResourceType("github", "discussion")).toBe("discussion");
    expect(canonicalResourceType("notion", "page")).toBe("page");
  });
});
