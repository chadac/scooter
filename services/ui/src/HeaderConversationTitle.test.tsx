/** The header title and the current conversation's star / rename / delete controls beside it. */

import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HeaderConversationTitle, confirmDeleteMessage } from "./HeaderConversationTitle.js";
import { sessionStore } from "./sessions.js";

const render = (actions: boolean) =>
  renderToStaticMarkup(createElement(HeaderConversationTitle, { actions }));

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  sessionStore.clearEditing();
  sessionStore.clearHover();
});

describe("HeaderConversationTitle", () => {
  it("shows the title with star, rename and delete when actions are on", () => {
    sessionStore.mergeFromServer([{ id: "h1", title: "Fix the parser" }]);
    sessionStore.requestSelect("h1");
    const html = render(true);
    expect(html).toContain("Fix the parser");
    for (const id of ["session-star", "session-rename", "session-delete"]) expect(html).toContain(id);
    // Phones get the same actions behind one menu button.
    expect(html).toContain("session-menu");
  });

  it("shows only the title without actions (the /chat subpage)", () => {
    sessionStore.mergeFromServer([{ id: "h2", title: "Fix the parser" }]);
    sessionStore.requestSelect("h2");
    const html = render(false);
    expect(html).toContain("Fix the parser");
    expect(html).not.toContain("session-delete");
  });

  it("swaps the title for the rename input while renaming", () => {
    sessionStore.mergeFromServer([{ id: "h3", title: "Old name" }]);
    sessionStore.requestSelect("h3");
    sessionStore.setEditing("h3");
    const html = render(true);
    expect(html).toContain("session-rename-input");
    expect(html).not.toContain("header-conversation-title");
    expect(html).not.toContain("session-delete");
  });

  it("hides the star for a subagent conversation", () => {
    sessionStore.mergeFromServer([{ id: "p1", title: "Parent" }, { id: "k1", title: "Child", parentId: "p1" }]);
    sessionStore.requestSelect("k1");
    const html = render(true);
    expect(html).not.toContain("session-star");
    expect(html).toContain("session-delete");
  });

  it("warns harder before deleting a starred conversation", () => {
    expect(confirmDeleteMessage({ title: "A", starred: true })).toMatch(/is starred/);
    expect(confirmDeleteMessage({ title: "A", starred: false })).not.toMatch(/starred/);
  });

  it("does not threaten to destroy a sandbox a never-sent conversation does not have", () => {
    expect(confirmDeleteMessage({ title: "New chat", starred: false }, false)).not.toMatch(/sandbox/);
    expect(confirmDeleteMessage({ title: "A", starred: false }, true)).toMatch(/sandbox/);
  });
});
