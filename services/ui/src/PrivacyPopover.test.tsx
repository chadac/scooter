/**
 * The privacy panel's taint status: what the owner reads, and when they can clear it.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TaintStatus } from "./PrivacyPopover.js";
import { clearTaintWarning } from "./sessionActions.js";
import type { TaintAuthor } from "./client.js";

const author = (label: string, conversationId = "c1"): TaintAuthor => ({
  conversationId, kind: "unknown", author: "", lastAt: 1, label,
});
const render = (authors: TaintAuthor[]) =>
  renderToStaticMarkup(
    createElement(TaintStatus, {
      load: { state: "loaded", view: { visibility: "private", summary: "", authors } },
      busy: false,
      onClear: () => {},
    }),
  );

describe("TaintStatus", () => {
  it("lists each author once, with a clear action", () => {
    const html = render([author("@someone (github)"), author("unattributed text"), author("unattributed text", "child")]);
    expect(html).toContain("taint-reasons");
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain("@someone (github)");
    expect(html).toContain("taint-clear");
  });

  it("says a clean conversation acts as the owner, with nothing to clear", () => {
    const html = render([]);
    expect(html).toContain("taint-clean");
    expect(html).not.toContain("taint-clear");
  });

  it("keeps credentials off when the check fails", () => {
    const html = renderToStaticMarkup(createElement(TaintStatus, { load: { state: "failed" }, busy: false, onClear: () => {} }));
    expect(html).toMatch(/Credentials stay off/);
  });
});

describe("clearTaintWarning", () => {
  it("names every author the owner vouches for, once", () => {
    const msg = clearTaintWarning(["user bob", "user bob", "unattributed text"]);
    expect(msg.match(/• user bob/g)).toHaveLength(1);
    expect(msg).toMatch(/• unattributed text/);
    expect(msg).toMatch(/taints the conversation again/);
  });
});
