/**
 * Sidebar search, provider filter chips and the "Show:" label mode.
 *
 * filteredSessions() composes scope, provider chips and the keyword query (which
 * matches titles and linked-resource names); sessionLabel() picks the title or a
 * provider's link name with title fallback.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  sessionStore,
  filteredSessions,
  sessionLabel,
  DRAFT_LABEL,
  linkName,
  primaryLink,
  type Session,
} from "./sessions.js";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  // The store is a module singleton, so reset the view state between tests.
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
  // The store boots with a current placeholder, so merge, switch onto a fixture, then re-merge to drop the placeholder as a phantom.
  sessionStore.mergeFromServer(CONVS);
  sessionStore.switchTo("gh");
  sessionStore.mergeFromServer(CONVS);
  // 'all' scope so ownership filtering doesn't interfere.
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

describe("Show: label mode (title | provider)", () => {
  it("title mode shows the conversation title", () => {
    seed();
    const gh = sessionStore.get().sessions.find((s) => s.id === "gh")!;
    expect(sessionLabel(gh, "title")).toBe("Fix flaky broker test");
  });

  it("a provider mode shows THAT provider's linked-resource name", () => {
    seed();
    const gh = sessionStore.get().sessions.find((s) => s.id === "gh")!;
    expect(sessionLabel(gh, "github")).toBe("org/app #203");
  });

  it("a provider mode falls back to the title when the row has no such link", () => {
    seed();
    const gh = sessionStore.get().sessions.find((s) => s.id === "gh")!;
    // gh has no Slack link, so the Slack mode falls back to its title.
    expect(sessionLabel(gh, "slack")).toBe("Fix flaky broker test");
    const plain = sessionStore.get().sessions.find((s) => s.id === "plain")!;
    expect(sessionLabel(plain, "github")).toBe("Scratch notes");
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

describe("an unsent draft under the Mine scope", () => {
  it("stays listed and labelled until its first send", () => {
    seed();
    sessionStore.setCurrentUser({ id: "u1" });
    sessionStore.setScope("mine");
    const id = sessionStore.newSession();
    const draft = filteredSessions(sessionStore.get()).find((s) => s.id === id);
    expect(draft).toBeDefined();
    expect(sessionLabel(draft!, "title")).toBe(DRAFT_LABEL);
    // Someone else's server conversations stay hidden.
    expect(filteredSessions(sessionStore.get()).map((s) => s.id)).toEqual([id]);
  });
});
