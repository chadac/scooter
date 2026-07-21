/**
 * Tier 1 (ui) — sidebar search + provider filter + Titles/Links label mode.
 *
 * Covers the store logic behind the three chat-list features: keyword search
 * (matches title AND linked-resource names), the provider filter chips (multi-
 * select, "none" = unlinked), and the label mode (show the linked PR/MR/thread
 * name instead of the title). filteredSessions() composes scope + provider +
 * query; sessionLabel() picks title vs link name.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  sessionStore,
  filteredSessions,
  sessionLabel,
  linkName,
  primaryLink,
  type Session,
} from "./sessions.js";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  // The store is a module singleton; reset the transient view state so filters/query
  // from a prior test don't leak into the next.
  sessionStore.setQuery("");
  sessionStore.clearProviders();
  sessionStore.setLabelMode("title");
});

// A conversation list with a GitHub PR, a Slack thread, and an unlinked chat.
const CONVS = [
  {
    id: "gh",
    title: "Fix flaky broker test",
    links: [
      { source: "github", resourceType: "pull_request", url: "https://github.com/org/app/pull/203", title: "org/app #203" },
    ],
  },
  {
    id: "slack",
    title: "Investigate outage",
    links: [{ source: "slack", resourceType: "thread", title: "#eng-help thread" }],
  },
  { id: "plain", title: "Scratch notes" },
];

function seed() {
  // The store boots with a pristine "New chat" that IS current (so it isn't dropped).
  // Merge the real convs, switch onto one, then re-merge so the untouched placeholder
  // is dropped as a phantom — leaving exactly our three fixtures.
  sessionStore.mergeFromServer(CONVS);
  sessionStore.switchTo("gh");
  sessionStore.mergeFromServer(CONVS);
  // 'all' scope so ownership filtering doesn't interfere with these assertions.
  sessionStore.setScope("all");
}

const ids = (ss: Session[]) => ss.map((s) => s.id).sort();

describe("keyword search (title + link names)", () => {
  it("matches the conversation title", () => {
    seed();
    sessionStore.setQuery("flaky");
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["gh"]);
  });

  it("matches a linked resource NAME (not in the title)", () => {
    seed();
    sessionStore.setQuery("#203");
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["gh"]);
  });

  it("matches a linked resource URL (repo name)", () => {
    seed();
    sessionStore.setQuery("org/app");
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["gh"]);
  });

  it("is case-insensitive and empty query matches everything", () => {
    seed();
    sessionStore.setQuery("INVESTIGATE");
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["slack"]);
    sessionStore.setQuery("");
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["gh", "plain", "slack"]);
  });
});

describe("provider filter chips", () => {
  it("no chips selected shows everything", () => {
    seed();
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["gh", "plain", "slack"]);
  });

  it("a provider chip shows only chats linked to that provider", () => {
    seed();
    sessionStore.toggleProvider("github");
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["gh"]);
  });

  it("multi-select is a union across providers", () => {
    seed();
    sessionStore.toggleProvider("github");
    sessionStore.toggleProvider("slack");
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["gh", "slack"]);
  });

  it("the 'none' chip matches UNLINKED chats", () => {
    seed();
    sessionStore.toggleProvider("none");
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["plain"]);
  });

  it("toggling a chip off restores it; clearProviders resets", () => {
    seed();
    sessionStore.toggleProvider("github");
    sessionStore.toggleProvider("github"); // off again
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["gh", "plain", "slack"]);
    sessionStore.toggleProvider("slack");
    sessionStore.clearProviders();
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["gh", "plain", "slack"]);
  });
});

describe("search + provider filter compose", () => {
  it("applies BOTH the query and the provider chips", () => {
    seed();
    sessionStore.toggleProvider("github");
    sessionStore.setQuery("outage"); // matches the Slack chat, but github chip excludes it
    expect(ids(filteredSessions(sessionStore.get()))).toEqual([]);
    sessionStore.setQuery("flaky"); // matches the github chat
    expect(ids(filteredSessions(sessionStore.get()))).toEqual(["gh"]);
  });
});

describe("Titles / Links label mode", () => {
  it("title mode shows the conversation title", () => {
    seed();
    const gh = sessionStore.get().sessions.find((s) => s.id === "gh")!;
    expect(sessionLabel(gh, "title")).toBe("Fix flaky broker test");
  });

  it("link mode shows the linked resource NAME when linked", () => {
    seed();
    const gh = sessionStore.get().sessions.find((s) => s.id === "gh")!;
    expect(sessionLabel(gh, "link")).toBe("org/app #203");
  });

  it("link mode falls back to the title for an UNLINKED chat", () => {
    seed();
    const plain = sessionStore.get().sessions.find((s) => s.id === "plain")!;
    expect(sessionLabel(plain, "link")).toBe("Scratch notes");
  });

  it("linkName falls back to '<source> <type>' when a link has no title", () => {
    expect(linkName({ source: "gitlab", resourceType: "merge_request" })).toBe("gitlab merge request");
    expect(linkName({ source: "github", resourceType: "pull_request", title: "org/app #7" })).toBe("org/app #7");
  });

  it("primaryLink is the first link, or undefined when unlinked", () => {
    seed();
    const gh = sessionStore.get().sessions.find((s) => s.id === "gh")!;
    const plain = sessionStore.get().sessions.find((s) => s.id === "plain")!;
    expect(primaryLink(gh)?.source).toBe("github");
    expect(primaryLink(plain)).toBeUndefined();
  });
});
